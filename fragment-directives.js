
const WS_RE = /[\s\u00A0]+/gu;
const INVISIBLE_TAGS = new Set(['img', 'svg', 'video', 'audio', 'object', 'embed', 'iframe', 'canvas', 'input', 'math']);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'colgroup',
  'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre',
  'search', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'br'
]);
const BLOCK_DISPLAY_STYLES = new Set(['block', 'table', 'table-cell', 'flow-root', 'grid', 'flex', 'list-item']);
const DOUBLE_QUOTES_RE = /[\u00AB\u00BB\u05F4\u201C-\u201F\u2E42\u301D-\u301F\uFF02]/g;
const SINGLE_QUOTES_RE = /[\u05F3\u2018-\u201B\u2039\u203A\u300C-\u300F\uFE41-\uFE44\uFF07\uFF62\uFF63]/g;
const BASE_COLLATOR = new Intl.Collator('und', { sensitivity: 'base' });
const FOLDED_CHARS = new Map();
const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };


// Folds one UTF-16 code unit for matching. Upper then lower case, with the
// marks removed, is close to Unicode case folding plus accent removal: ς, ſ
// and µ become σ, s and μ, ß becomes ss, and é becomes e. But it also turns
// dotless ı into i and drops Thai vowel signs, which the browsers' primary-
// strength matching keeps. So the fold is used only if a base-sensitivity
// collator, which compares the same way, finds it equal to the original.
function foldChar(ch) {
  let folded = FOLDED_CHARS.get(ch);
  if (folded !== undefined) return folded;
  folded = ch.toUpperCase().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (BASE_COLLATOR.compare(ch, folded) !== 0) folded = ch.toLowerCase();
  FOLDED_CHARS.set(ch, folded);
  return folded;
}

// Descendants of root in shadow-including tree order: each node, then its open
// shadow tree, then its children.
function* shadowIncludingDescendants(root) {
  const stack = [];
  const pushChildren = node => {
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
    const shadow = node.shadowRoot;
    if (shadow) {
      for (let child = shadow.lastChild; child; child = child.previousSibling) stack.push(child);
    }
  };
  pushChildren(root);
  while (stack.length) {
    const node = stack.pop();
    yield node;
    pushChildren(node);
  }
}

// Node.contains doesn't cross shadow boundaries.
function shadowIncludingContains(ancestor, node) {
  for (let n = node; n; n = n.parentNode ?? n.host) {
    if (n === ancestor) return true;
  }
  return false;
}

export class TextFragmentResolver {
  #sectionLocators = new Map();
  #rangeCacheBySection = new Map();
  #sectionBuildTimers = new Map();
  #sectionBuildState = new Map();
  #sectionBuildDoc = new Map();
  #normalizedTextMapByDoc = new WeakMap();

  //#docObservers = new WeakMap();

  #rangeCacheBuildStarted = 0

  #options;

  constructor(options = {}) {
    this.#options = Object.freeze({
      allowCrossBlockTerms: false,
      staticBlockTags: false,
      log: "warn",
  ...options,
    });
  }

  static buildBatchTimeChunk = 10;
  static buildDelayMs = 8;

  #log(level, ...args) {
    const threshold = LOG_LEVELS[this.#options.log] ?? LOG_LEVELS.warn;
    if (LOG_LEVELS[level] > threshold) return;
    const method = level === "error" || level === "warn" ? level : "log";
    console[method]("[TF]", ...args);
  }

  decodeComponent(value) {
    if (value == null) return "";
    try {
      // A "%" not followed by two hex digits is a literal "%", as in the URL
      // spec's percent-decode, rather than an error for the whole term.
      return decodeURIComponent(value.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
    } catch {
      return value;
    }
  }

  #collapseWhitespace(value) {
      return this.#caseFold(value.replace(WS_RE, " "));
  }

  #collapseAndTrimEdges(s, stripLeft, stripRight) {
      let result = this.#collapseWhitespace(s);
      if (stripLeft) result = result.trimStart();
      if (stripRight) result = result.trimEnd();
      return result;
  }

  #caseFold(s) {
    // Fold a character at a time, the same as the document, so that context
    // rules like a final ς apply to neither.
    let folded = "";
    for (let i = 0; i < s.length; i++) {
      folded += foldChar(s[i]);
    }
    return folded
        .replace(DOUBLE_QUOTES_RE, '"')
        .replace(SINGLE_QUOTES_RE, "'")
  }

  isTextFragmentLocator(value) {
    const result = typeof value === "string" && value.startsWith(":~:text=");
    return result;
  }

  getTextFragmentLocator(target) {
    if (typeof target !== 'string') {
      return null
    }
    const index = target.indexOf(':~:text=')
    return index < 0 ? null : target.slice(index)
  }

  splitTextDirectives(locator) {
    if (typeof locator !== "string") {
      return [];
    }

    let fragment = locator;

    const hashDirectiveIndex = fragment.indexOf("#:~:");
    if (hashDirectiveIndex >= 0) {
      fragment = fragment.slice(hashDirectiveIndex + 4);
    } else {
      const bareDirectiveIndex = fragment.indexOf(":~:");
      if (bareDirectiveIndex >= 0) {
        fragment = fragment.slice(bareDirectiveIndex + 3);
      }
    }

    if (!fragment.startsWith("text=") && !fragment.includes("&text=")) {
      this.#log("info", "splitTextDirectives no text= found", fragment);
      return [];
    }

    const directives = fragment
    .split("&")
    .filter(part => part.startsWith("text="))
    .map(part => part.slice(5));

    return directives;
  }

  registerTextFragmentLocators(doc, sectionIndex, jsonString) {
    let locators;
    try {
      locators = JSON.parse(jsonString);
    } catch (error) {
      this.#log("error", "Failed to parse section locators JSON:", error);
      return;
    }

    if (!Array.isArray(locators)) {
      this.#log("warn","registerTextFragmentLocators expected array") ;
      return;
    }

    this.#sectionLocators.set(sectionIndex, locators);
    this.#resetSectionLocatorCache(sectionIndex);
    this.#sectionBuildDoc.delete(sectionIndex);

    if (doc) {
      this.ensureSectionCacheBuilding(doc, sectionIndex);
    }
    this.#log("info",`Registered ${locators.length} locators for section ${sectionIndex}`);
  }

  parseTextSelector(raw) {
    let s = raw;
    const tokens = raw.split(",");
    if (tokens.length > 4) return this.#badSelector(raw);

    let prefix = null;
    if (tokens[0].endsWith("-")) {
      prefix = tokens.shift().slice(0, -1);
      if (!prefix || prefix.includes("-") || !tokens.length) return this.#badSelector(raw);
    }

    let suffix = null;
    if (tokens[tokens.length - 1].startsWith("-")) {
      suffix = tokens.pop().slice(1);
      if (!suffix || suffix.includes("-") || !tokens.length) return this.#badSelector(raw);
    }

    if (tokens.length > 2) return this.#badSelector(raw);
    const [start, end = null] = tokens;
    if (!start || start.includes("-")) return this.#badSelector(raw);
    if (end !== null && (!end || end.includes("-"))) return this.#badSelector(raw);

    const decode = term => term == null ? null : this.decodeComponent(term);
    return {
      raw,
      prefix: decode(prefix),
      start: decode(start),
      end: decode(end),
      suffix: decode(suffix),
    };

    return parsed;
  }

  #badSelector(raw) {
    this.#log("warn", "parseTextSelector bad selector:", raw);
    return null;
  }

  shouldSkipTextNode(node, doc, skipCache) {
    const parent = node.parentElement;
    if (!parent) return false;
    const cached = skipCache?.get(parent);
    if (cached !== undefined) return cached;

    const tag = parent.tagName?.toLowerCase();
    let result = false;
    if (tag === "script" || tag === "style" || parent.closest("head")) {
      result = true;
    } else {
      const style = doc.defaultView?.getComputedStyle(parent);
      result = style?.display === "none" || style?.visibility === "hidden";
    }
    skipCache?.set(parent, result);
    return result;
  }

  isBlockElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.tagName?.toLowerCase() === 'br') return true;
    if (this.#options.staticBlockTags) return BLOCK_TAGS.has(el.tagName?.toLowerCase());

    const display = el.ownerDocument.defaultView?.getComputedStyle(el)?.display;
    const result = !display ? BLOCK_TAGS.has(el.tagName?.toLowerCase()) : BLOCK_DISPLAY_STYLES.has(display) || display.split(' ').includes('list-item');
    return result;
  }

  buildNormalizedTextMap(doc) {
    const root = doc.documentElement;

    const entries = [];
    let normalized = "";
    let text = "";
    const normAt = [];
    let pendingSpace = false;

    let pendingBreak = false;
    const openBlocks = [];
    const blockBoundaries = new Set();
    const skipCache = new Map();
    let hiddenRoot = null;

    for (const node of shadowIncludingDescendants(root)) {
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) continue;

      // Skip everything inside an element with display: none. display isn't
      // inherited, so the text's own parent can still look visible.
      if (hiddenRoot) {
        if (shadowIncludingContains(hiddenRoot, node)) continue;
        hiddenRoot = null;
      }

      // Blocks we have left since the previous node; capped at one separator.
      while (openBlocks.length && !shadowIncludingContains(openBlocks[openBlocks.length - 1], node)) {
        openBlocks.pop();
        if (normalized.length > 0) pendingBreak = true;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        if (doc.defaultView?.getComputedStyle(node)?.display === "none") {
          hiddenRoot = node;
          continue;
        }
        const tag = node.tagName?.toLowerCase();
        if (!INVISIBLE_TAGS.has(tag) && this.isBlockElement(node)) {
          openBlocks.push(node);
        }
        continue;
      }

      const raw = node.nodeValue ?? "";
      if (!raw) continue;
      if (this.shouldSkipTextNode(node, doc, skipCache)) continue;

      for (let rawIndex = 0; rawIndex < raw.length; rawIndex++) {
        const ch = raw[rawIndex];
        const isSpace = WS_RE.test(ch);
        WS_RE.lastIndex = 0;

        if (isSpace) {
          pendingSpace = true;
          continue;
        }

        if ((pendingBreak || pendingSpace) && normalized.length > 0) {
          normAt.push(normalized.length);
          text += " ";
          normalized += " ";
        }

       const wasBreak = pendingBreak;

       pendingBreak = false;
       pendingSpace = false;

       const normStart = normalized.length;
       if (wasBreak && normStart > 0) blockBoundaries.add(normStart);
        normAt.push(normStart);
        text += ch;
        normalized += this.#caseFold( ch )

        entries.push({
          normStart,
          normEnd: normalized.length,
          node,
          rawStart: rawIndex,
          rawEnd: rawIndex + 1,
        });
      }
    }

    // Segment the unfolded text. Folding strips marks, which changes how
    // dictionary-based scripts like Thai are split into words.
    normAt.push(normalized.length);
    const segmenter = new Intl.Segmenter([], { granularity: "word" });
    const wordBoundaries = new Set([0, normalized.length]);
    for (const seg of segmenter.segment(text)) {
      wordBoundaries.add(normAt[seg.index]);
      wordBoundaries.add(normAt[seg.index + seg.segment.length]);
    }

    /*
    console.debug("buildNormalizedTextMap summary", {
      normalizedLength: normalized.length,
      entryCount: entries.length,
      previewStart: normalized.slice(0, 200),
      previewEnd: normalized.slice(-200),
    });
     */

    return { normalized, entries, wordBoundaries, blockBoundaries };
  }

  #getNormalizedTextMap(doc) {
    let map = this.#normalizedTextMapByDoc.get(doc);
    if (map) return map;

    map = this.buildNormalizedTextMap(doc);
    this.#normalizedTextMapByDoc.set(doc, map);
    return map;
  }

  invalidateCachesForDoc(doc) {
    this.#log("debug", "Clearing textMap and range caches");
      this.#normalizedTextMapByDoc.delete(doc);
      for (const [sectionIndex, cache] of this.#rangeCacheBySection) {
        for (const [locator, entry] of cache) {
          if (entry.doc === doc) {
            cache.delete(locator);
          }
        }
      }
  }

  reset() {
    for (const timer of this.#sectionBuildTimers.values()) {
      clearTimeout(timer);
    }
    this.#sectionLocators.clear();
    this.#rangeCacheBySection.clear();
    this.#sectionBuildTimers.clear();
    this.#sectionBuildState.clear();
    this.#sectionBuildDoc.clear();
    this.#normalizedTextMapByDoc = new WeakMap();
    this.#rangeCacheBuildStarted = 0;
  }

  #shouldRejectCrossBlockTerm(blockBoundaries, from, to) {
    if (this.#options.allowCrossBlockTerms) return false;
    for (let b = from + 1; b < to; b++) {
      if (blockBoundaries.has(b)) return true;
    }
    return false;
  }

  findFirstMatch(docNorm, blockBoundaries, wordBoundaries, selector) {
    const hasEnd = selector.end != null;
    const hasSuffix = selector.suffix != null;
    const start = this.#collapseAndTrimEdges(selector.start, true, !(hasEnd || hasSuffix));
    const end = hasEnd ? this.#collapseAndTrimEdges(selector.end, false, !hasSuffix) : null;

    const prefix = selector.prefix ? this.#collapseWhitespace(selector.prefix) : null;
    const suffix = selector.suffix ? this.#collapseWhitespace(selector.suffix) : null;

    if (!start) return null;

    let pos = 0;

    while (true) {
      const i = docNorm.indexOf(start, pos);
      if (i < 0) {
        return null;
      }

      if (end) {
        // Check word boundary at start (only if no prefix)
        if (!prefix && !wordBoundaries.has(i)) {
          pos = i + 1;
          continue;
        }

        const startEnd = i + start.length;

        // Right edge of start must also be word-bounded (inner boundary)
        if (!wordBoundaries.has(startEnd)) {
          pos = i + 1;
          continue;
        }

        if (this.#shouldRejectCrossBlockTerm(blockBoundaries, i, startEnd)) {
          pos = i + 1;
          continue;
        }

        let j = docNorm.indexOf(end, startEnd);

        while (j >= 0) {
          // Left edge of end must be word-bounded (inner boundary)
          if (!wordBoundaries.has(j)) {
            j = docNorm.indexOf(end, j + 1);
            continue;
          }

          const matchEnd = j + end.length;
          // Check word boundary at end (only if no suffix)
          if (!suffix && !wordBoundaries.has(matchEnd)) {
            j = docNorm.indexOf(end, j + 1);
            continue;
          }
          if (this.#shouldRejectCrossBlockTerm(blockBoundaries, j, matchEnd)) {
            j = docNorm.indexOf(end, j + 1);
            continue;
          }

          if (prefix && !this.#prefixMatches(docNorm, wordBoundaries, blockBoundaries, i, prefix)) {
            break;
          }
          if (suffix && !this.#suffixMatches(docNorm, wordBoundaries, blockBoundaries, matchEnd, suffix)) {
            j = docNorm.indexOf(end, j + 1);
            continue
          }

          const match = {
            startIndex: i,
            endIndex: matchEnd,
          };
          return match;
        }

        pos = i + 1;
        continue;
      }

      // Non-range case (no end term)
      const matchEnd = i + start.length;

      // Check word boundary at start (only if no prefix)
      if (!prefix && !wordBoundaries.has(i)) {
        pos = i + 1;
        continue;
      }
      // Check word boundary at end (only if no suffix)
      if (!suffix && !wordBoundaries.has(matchEnd)) {
        pos = i + 1;
        continue;
      }

      if (this.#shouldRejectCrossBlockTerm(blockBoundaries, i, matchEnd)) {
        pos = i + 1;
        continue;
      }

      if (prefix && !this.#prefixMatches(docNorm, wordBoundaries, blockBoundaries, i, prefix)) {
        pos = i + 1;
        continue;
      }

      if (suffix && !this.#suffixMatches(docNorm, wordBoundaries, blockBoundaries, matchEnd, suffix)) {
        pos = i + 1;
        continue
      }

      const match = {
        startIndex: i,
        endIndex: matchEnd,
      };
      return match;
    }
  }

  findStartPoint(entries, offset) {
    for (const entry of entries) {
      // Skip the empty entry of a combining mark left over from the previous
      // character.
      if (entry.normStart === offset && entry.normEnd > offset) {
        return { node: entry.node, offset: entry.rawStart };
      }
      if (entry.normStart < offset && entry.normEnd > offset) {
        return { node: entry.node, offset: entry.rawStart };
      }
    }

    return null;
  }

  findEndPoint(entries, offset) {
    for (let i = 0; i < entries.length; i++) {
      let entry = entries[i];

      if (entry.normEnd === offset) {
        // Combining marks fold to nothing, so their entries are empty. Take in
        // any that follow the last character.
        while (i + 1 < entries.length && entries[i + 1].normStart === offset && entries[i + 1].normEnd === offset) {
          entry = entries[++i];
        }
        return { node: entry.node, offset: entry.rawEnd };
      }
      if (entry.normStart < offset && entry.normEnd >= offset) {
        return { node: entry.node, offset: entry.rawEnd };
      }
    }

    return null;
  }

  makeRangeFromMatch(doc, entries, match) {
    const startPoint = this.findStartPoint(entries, match.startIndex);
    const endPoint = this.findEndPoint(entries, match.endIndex);
    
    if (!startPoint || !endPoint) {
      return null;
    }
    
    const range = doc.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
  }

  resolveTextFragmentRange(doc, sectionIndex, locator) {
    if (!doc) {
      this.#log("warn","No doc in resolveTextFragment");
      return null;
    }

    this.ensureSectionCacheBuilding(doc, sectionIndex);

    const cachedRange = this.getCachedRange(doc, sectionIndex, locator );
    if (cachedRange) {
      return cachedRange;
    }

    const directives = this.splitTextDirectives(locator);
    if (!directives.length) {
         this.#log("debug","resolveTextFragmentRange no directives");
         return null;
    }
    // Use the first directive that matches, as a browser does when scrolling.
    const { normalized, entries, wordBoundaries, blockBoundaries } = this.#getNormalizedTextMap(doc);
    let range = null;
    for (const directive of directives) {
      const selector = this.parseTextSelector(directive);
      if (!selector) continue;
      const match = this.findFirstMatch(normalized, blockBoundaries, wordBoundaries, selector);
      if (match) {
        range = this.makeRangeFromMatch(doc, entries, match);
        if (range) break;
      }
    }
    if (!range) {
      this.#log("info",`No match found for text fragment locator: ${locator}`);
      return null;
    }
    this.setCachedRange(doc, sectionIndex, locator, range);
    return range;
  }

  #prefixMatches(docNorm, wordBoundaries, blockBoundaries, pos, prefix) {
    const before = docNorm.slice(0, pos);
    const trimmedPrefix = prefix.trimEnd();

    if (!before.trimEnd().endsWith(trimmedPrefix)) {
      return false;
    }

    // If prefix has trailing space, require space in document before textStart
    if (prefix.endsWith(" ") && before.trimEnd().length >= before.length) {
      return false;
    }

    const beforeTrimmed = before.trimEnd();
    const preStart = beforeTrimmed.length - trimmedPrefix.length;
    if (!wordBoundaries.has(preStart)) {
      return false;
    }
    if (this.#shouldRejectCrossBlockTerm(blockBoundaries, preStart, beforeTrimmed.length)) {
      return false;
    }

    return true;
  }

  #suffixMatches(docNorm, wordBoundaries, blockBoundaries, pos, suffix) {
    const after = docNorm.slice(pos);
    const trimmedSuffix = suffix.trimStart();

    if (!after.trimStart().startsWith(trimmedSuffix)) {
      return false;
    }

    // If suffix has leading space, require space in document after textEnd
    if (suffix.startsWith(" ") && after.trimStart().length >= after.length) {
      return false;
    }

    const afterTrimmed = after.trimStart();
    const suffixStart = pos + (after.length - afterTrimmed.length);
    const suffixEnd = suffixStart + trimmedSuffix.length;
    if (!wordBoundaries.has(suffixEnd)) {
      return false;
    }

    if (this.#shouldRejectCrossBlockTerm(blockBoundaries, suffixStart, suffixEnd)) {
      return false;
    }

    return true;
  }

  #resetSectionLocatorCache(sectionIndex) {
    const timer = this.#sectionBuildTimers.get(sectionIndex);
    if (timer != null) {
      clearTimeout(timer);
    }

    this.#sectionBuildTimers.delete(sectionIndex);
    this.#sectionBuildState.delete(sectionIndex);
    this.#rangeCacheBySection.delete(sectionIndex);
  }

  #isSectionCacheBuildInProgress(sectionIndex) {
    return this.#sectionBuildTimers.has(sectionIndex)
    || this.#sectionBuildState.has(sectionIndex);
  }

  ensureSectionCacheBuilding(doc, sectionIndex ) {
    if (this.#isSectionCacheBuildInProgress(sectionIndex)) {
      return;
    }

    // Don't build on empty/placeholder documents
    if (!doc || doc.URL === "about:blank" || !doc.body?.hasChildNodes()) {
      this.#log("info",`Skipping cache build for section ${sectionIndex} - document not ready`);
      return;
    }

    const locators = this.#sectionLocators.get(sectionIndex);
    if (!Array.isArray(locators) || !locators.length) {
      return;
    }

    const startedDoc = this.#sectionBuildDoc.get(sectionIndex);
    if (startedDoc === doc) return;

    this.#resetSectionLocatorCache(sectionIndex);
    this.#sectionBuildDoc.set(sectionIndex, doc);

    this.#startIncrementalLocatorCacheBuild(doc, sectionIndex );
  }

  #startIncrementalLocatorCacheBuild(doc, sectionIndex) {

    const locators = this.#sectionLocators.get(sectionIndex);
    if (!Array.isArray(locators) || !locators.length) {
      return;
    }

    this.#rangeCacheBuildStarted = performance.now()
    this.#log("debug", `Starting range cache build for section: ${sectionIndex}` )

   // this.#sectionBuildState.set(sectionIndex, { nextIndex: 0 });
    this.#sectionBuildState.set(sectionIndex, { nextIndex: 0, prevRange: null });


    const scheduleNext = () => {
      const timer = setTimeout(() => {
        this.#buildLocatorCacheChunk(doc, sectionIndex);
      }, TextFragmentResolver.buildDelayMs);
      this.#sectionBuildTimers.set(sectionIndex, timer);
    };

    scheduleNext();
  }

  #buildLocatorCacheChunk(doc, sectionIndex) {
    const locators = this.#sectionLocators.get(sectionIndex);
    const state = this.#sectionBuildState.get(sectionIndex);

    if (!Array.isArray(locators) || !state) {
      this.#sectionBuildTimers.delete(sectionIndex);
      this.#log("debug", "locatorCacheChunk: no locators" );
      return;
    }

    const cache = this.getSectionRangeCache(sectionIndex);
    const deadline = performance.now() + TextFragmentResolver.buildBatchTimeChunk ;

    let index = state.nextIndex
    let built = 0

    try {
      while (index < locators.length && performance.now() < deadline) {
        const locator = locators[index];
        const entry = cache.get(locator);
        if (entry?.doc === doc && entry.range) {
          index += 1
          continue;
        }
        //this.resolveTextFragmentRange( doc, sectionIndex, locator )
        const range = this.resolveTextFragmentRange(doc, sectionIndex, locator);
        if (range) {
          if (state.prevRange &&
              range.compareBoundaryPoints(Range.START_TO_START, state.prevRange) < 0) {
            this.#log("warn", `Out-of-order pre-cached locator at index ${index}: ${locator}`);
          }
          state.prevRange = range;
        }
        built += 1
        index += 1
      }
    } catch (error) {
      this.#log("error", `Range cache build aborted for section ${sectionIndex} at index ${index}: ${locators[index]}`, error);
      this.#sectionBuildState.delete(sectionIndex);
      this.#sectionBuildTimers.delete(sectionIndex);
      return;
    }

    state.nextIndex = index;

    if (state.nextIndex >= locators.length) {
      this.#sectionBuildState.delete(sectionIndex);
      this.#sectionBuildTimers.delete(sectionIndex);
      const cacheBuildTime = performance.now() - this.#rangeCacheBuildStarted
      this.#log("debug", `Finished range cache build for section ${sectionIndex}, ${locators.length} locators -- ${cacheBuildTime} ms` );
      return;
    }

    const timer = setTimeout(() => {
      this.#buildLocatorCacheChunk(doc, sectionIndex);
    }, TextFragmentResolver.buildDelayMs);
    this.#sectionBuildTimers.set(sectionIndex, timer);
  }

  hasTextFragmentLocators(sectionIndex) {
    const locators = this.#sectionLocators.get(sectionIndex);
    return Array.isArray(locators) && locators.length > 0;
  }
  getTextFragmentLocators(sectionIndex) {
    return this.#sectionLocators.get(sectionIndex) ?? [];
  }

  getSectionRangeCache(sectionIndex) {
    let cache = this.#rangeCacheBySection.get(sectionIndex);
    if (cache) return cache;

    cache = new Map();
    this.#rangeCacheBySection.set(sectionIndex, cache);
    return cache;
  }

  getCachedRange(doc, sectionIndex, locator) {
    const cache = this.#rangeCacheBySection.get(sectionIndex);
    if (!cache) return null;

    const entry = cache.get(locator);
    if (!entry) return null;
    if (entry.doc !== doc) return null;
    if (!entry.range) return null;

    return entry.range.cloneRange();
  }

  setCachedRange(doc, sectionIndex, locator, range) {
    const cache = this.getSectionRangeCache(sectionIndex);
    cache.set(locator, {
      doc,
      range: range.cloneRange(),
    });
  }

  findFirstCachedLocatorContainingRange(doc, sectionIndex, selectedRange) {
    this.ensureSectionCacheBuilding(doc, sectionIndex);

    const cache = this.#rangeCacheBySection.get(sectionIndex);
    if (!cache || !selectedRange) return null;

    const cleanedSelectedRange = this.#cleanupRange(selectedRange);

    for (const [locator, entry] of cache) {
      if (entry?.doc !== doc || !entry.range) continue;
      if (this.#eitherRangeContainsOther(entry.range, cleanedSelectedRange)) {
        return locator;
      }
    }

    return null;
  }

  /*
   * This shoudn't be necessary but in some books the selected range isnt on a word
   * boundary and, instead, contains a leading or trailing space. That might be a bug
   * upstream, but it causes the findLocator to fail so this function is called to trim
   * the selection.
   */
  #cleanupRange(range) {
    const trimmed = range.cloneRange();
    while (!trimmed.collapsed) {
      const n = trimmed.startContainer;
      if (n.nodeType === Node.TEXT_NODE && /\s/.test(n.nodeValue[trimmed.startOffset]))
        trimmed.setStart(n, trimmed.startOffset + 1);
      else break;
    }
    while (!trimmed.collapsed) {
      const n = trimmed.endContainer;
      if (n.nodeType === Node.TEXT_NODE && trimmed.endOffset > 0 && /\s/.test(n.nodeValue[trimmed.endOffset - 1]))
        trimmed.setEnd(n, trimmed.endOffset - 1);
      else break;
    }
    return trimmed;
  }

  #eitherRangeContainsOther(rangeA, rangeB) {
    try {
      const aStart = rangeA.compareBoundaryPoints(Range.START_TO_START, rangeB);
      const aEnd = rangeA.compareBoundaryPoints(Range.END_TO_END, rangeB);
      return (aStart <= 0 && aEnd >= 0) || (aStart >= 0 && aEnd <= 0);
    } catch {
      return false;
    }
  }
}
