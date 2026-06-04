
const WS_RE = /[\s\u00A0]+/gu;
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'colgroup',
  'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre',
  'search', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'br'
]);



export class TextFragmentResolver {
  #sectionLocators = new Map();
  #rangeCacheBySection = new Map();
  #sectionBuildTimers = new Map();
  #sectionBuildState = new Map();
  #sectionBuildDoc = new Map();
  #normalizedTextMapByDoc = new WeakMap();
  //#docObservers = new WeakMap();

  #rangeCacheBuildStarted = 0

  static buildBatchTimeChunk = 10;
  static buildDelayMs = 8;

  decodeComponent(value) {
    if (value == null) return "";
    try {
      return decodeURIComponent(value.replace(/\+/g, " "));
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
      return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  }

  isWordChar(ch) {
    return /[\p{L}\p{N}]/u.test(ch);
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
      console.warn("[TF]", "splitTextDirectives no text= found", fragment);
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
      console.error("[TF] Failed to parse section locators JSON:", error);
      return;
    }

    if (!Array.isArray(locators)) {
      console.warn("[TF] registerTextFragmentLocators expected array");
      return;
    }

    this.#sectionLocators.set(sectionIndex, locators);
    this.#resetSectionLocatorCache(sectionIndex);
    this.#sectionBuildDoc.delete(sectionIndex);

    if (doc) {
      this.ensureSectionCacheBuilding(doc, sectionIndex);
    }
    console.log(`[TF] Registered ${locators.length} locators for section ${sectionIndex}`);
  }

  parseTextSelector(raw) {
    let s = raw;

    let suffixRaw = null;
    const suffixIndex = s.lastIndexOf(",-");
    if (suffixIndex >= 0) {
      suffixRaw = s.slice(suffixIndex + 2);
      s = s.slice(0, suffixIndex);
    }

    let prefixRaw = null;
    const prefixIndex = s.indexOf("-,");
    if (prefixIndex >= 0) {
      prefixRaw = s.slice(0, prefixIndex);
      s = s.slice(prefixIndex + 2);
    }

    let startRaw = s;
    let endRaw = null;
    const commaIndex = s.indexOf(",");
    if (commaIndex >= 0) {
      startRaw = s.slice(0, commaIndex);
      endRaw = s.slice(commaIndex + 1);
    }

    const start = this.decodeComponent(startRaw);
    if (!start) {
      console.warn("[TF] parseTextSelector bad selector: empty start");
      return null;
    }

    const parsed = {
      raw,
      prefix: prefixRaw != null ? this.decodeComponent(prefixRaw) : null,
      start,
      end: endRaw != null && endRaw !== "" ? this.decodeComponent(endRaw) : null,
      suffix: suffixRaw != null ? this.decodeComponent(suffixRaw) : null,
    };

    return parsed;
  }

  shouldSkipTextNode(node, doc) {
    const parent = node.parentElement;
    if (!parent) return false;

    const tag = parent.tagName?.toLowerCase();
    if (tag === "script" || tag === "style") return true;
    if (parent.closest("head")) return true;

    const style = doc.defaultView?.getComputedStyle(parent);
    if (style?.display === "none") return true;
    if (style?.visibility === "hidden") return true;

    return false;
  }

  isBlockElement(el) {
    return el && BLOCK_TAGS.has(el.tagName?.toLowerCase());
  }


  hasBlockBoundaryBetween(prevNode, node) {
    // Walk up from prevNode until we find an ancestor that contains both nodes
    let ancestor = prevNode.parentElement;
    while (ancestor && !ancestor.contains(node)) {
      if (this.isBlockElement(ancestor)) {
        return true;
      }
      ancestor = ancestor.parentElement;
    }

    // Walk up from node until we find an ancestor that contains both nodes
    ancestor = node.parentElement;
    while (ancestor && !ancestor.contains(prevNode)) {
      if (this.isBlockElement(ancestor)) {
        return true;
      }
      ancestor = ancestor.parentElement;
    }


    // Walk document order between prevNode and node looking for block elements
    // (catches text<br/>text case and other non-whitespace separated block siblings/cousins)
    const commonAncestor = prevNode.parentElement?.contains(node)
    ? prevNode.parentElement
    : node.parentElement;
    if (commonAncestor) {
      const elWalker = prevNode.ownerDocument.createTreeWalker( commonAncestor, NodeFilter.SHOW_ELEMENT );
      elWalker.currentNode = prevNode;
      let el = elWalker.nextNode();
      while (el && el !== node && !(el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING)) {
        if (this.isBlockElement(el)) return true;
        el = elWalker.nextNode();
      }
    }

    return false;
  }

  buildNormalizedTextMap(doc) {
    const root = doc.documentElement;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    const entries = [];
    let normalized = "";
    let pendingSpace = false;

    let prevNode = null;

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const raw = node.nodeValue ?? "";
      if (!raw) continue;
      if (this.shouldSkipTextNode(node, doc)) continue;

      if (prevNode && normalized.length > 0 && !normalized.endsWith(" ")) {
         if (this.hasBlockBoundaryBetween(prevNode, node)) {
           pendingSpace = true;
         }
       }
      prevNode = node;

      for (let rawIndex = 0; rawIndex < raw.length; rawIndex++) {
        const ch = raw[rawIndex];
        const isSpace = WS_RE.test(ch);
        WS_RE.lastIndex = 0;

        if (isSpace) {
          pendingSpace = true;
          continue;
        }

        if (pendingSpace && normalized.length > 0) {
          normalized += " ";
        }
        pendingSpace = false;


        const normStart = normalized.length;
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

    const segmenter = new Intl.Segmenter([], { granularity: "word" });
    const wordBoundaries = new Set([0, normalized.length]);
    for (const seg of segmenter.segment(normalized)) {
      wordBoundaries.add(seg.index);
      wordBoundaries.add(seg.index + seg.segment.length);
    }

    /*
    console.debug("[TF] buildNormalizedTextMap summary", {
      normalizedLength: normalized.length,
      entryCount: entries.length,
      previewStart: normalized.slice(0, 200),
      previewEnd: normalized.slice(-200),
    });
     */

    return { normalized, entries, wordBoundaries };
  }

  #getNormalizedTextMap(doc) {
    let map = this.#normalizedTextMapByDoc.get(doc);
    if (map) return map;

    map = this.buildNormalizedTextMap(doc);
    this.#normalizedTextMapByDoc.set(doc, map);
    return map;
  }

  invalidateCachesForDoc(doc) {
    console.log("[TF] Clearing textMap and range caches");
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

  findAllIndices(haystack, needle, fromIndex = 0) {
    const indices = [];
    if (!needle) return indices;

    let pos = fromIndex;
    while (true) {
      const found = haystack.indexOf(needle, pos);
      if (found < 0) break;
      indices.push(found);
      pos = found + 1;
    }

    return indices;
  }

  findFirstMatch(docNorm, wordBoundaries, selector) {
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

          if (prefix && !this.#prefixMatches(docNorm, wordBoundaries, i, prefix)) {
              break;
          }

          if (suffix && !this.#suffixMatches(docNorm, wordBoundaries, matchEnd, suffix)) {
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

      if (prefix && !this.#prefixMatches(docNorm, wordBoundaries, i, prefix)) {
        pos = i + 1;
        continue;
      }

      if (suffix && !this.#suffixMatches(docNorm, wordBoundaries, matchEnd, suffix)) {
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
      if (entry.normStart === offset) {
        return { node: entry.node, offset: entry.rawStart };
      }
      if (entry.normStart < offset && entry.normEnd > offset) {
        return { node: entry.node, offset: entry.rawStart };
      }
    }

    return null;
  }

  findEndPoint(entries, offset) {
    for (const entry of entries) {
      if (entry.normEnd === offset) {
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
      console.warn("[TF] No doc in resolveTextFragment");
      return null;
    }

    this.ensureSectionCacheBuilding(doc, sectionIndex);

    const cachedRange = this.getCachedRange(doc, sectionIndex, locator );
    if (cachedRange) {
      return cachedRange;
    }

    const directives = this.splitTextDirectives(locator);
    if (!directives.length) {
         console.warn("[TF] resolveTextFragmentRange no directives");
         return null;
    }
    const directive = directives[0];

    const selector = this.parseTextSelector(directive);
    if (!selector) {
      console.warn("[TF] Bad text fragment selector");
      return null;
    }

    const { normalized, entries, wordBoundaries } = this.#getNormalizedTextMap(doc)
    const match = this.findFirstMatch(normalized, wordBoundaries, selector);
    if (!match) {
      console.warn( `[TF] No match found for text fragment locator: ${locator}`);
      return null;
    }
    const range = this.makeRangeFromMatch(doc, entries, match);
    if (range ) {
      this.setCachedRange(doc, sectionIndex, locator, range);
    }

    return range;
  }

  #prefixMatches(docNorm, wordBoundaries, pos, prefix) {
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

    return true;
  }

  #suffixMatches(docNorm, wordBoundaries, pos, suffix) {
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
    const sufEndAbs = pos + (after.length - afterTrimmed.length) + trimmedSuffix.length;
    if (!wordBoundaries.has(sufEndAbs)) {
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
      console.log(`[TF] Skipping cache build for section ${sectionIndex} - document not ready`);
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
    console.log( `[TF] Starting range cache build for section: ${sectionIndex}` )

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
      console.log( "[TF] locatorCacheChunk: no locators" );
      return;
    }

    const cache = this.getSectionRangeCache(sectionIndex);
    const deadline = performance.now() + TextFragmentResolver.buildBatchTimeChunk ;

    let index = state.nextIndex
    let built = 0

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
          console.warn(`[TF] Out-of-order locator at index ${index}: ${locator}`);
        }
        state.prevRange = range;
      }
      built += 1
      index += 1
    }

    state.nextIndex = index;

    if (state.nextIndex >= locators.length) {
      this.#sectionBuildState.delete(sectionIndex);
      this.#sectionBuildTimers.delete(sectionIndex);
      const cacheBuildTime = performance.now() - this.#rangeCacheBuildStarted
      console.log( `[TF] Finished range cache build for section ${sectionIndex}, ${locators.length} locators -- ${cacheBuildTime} ms` );
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
