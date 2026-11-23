(() => {
  const out = [];
  // text overflow: a block whose content is clipped or scrolled past its box
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const clips = cs.overflow === 'hidden' || cs.overflow === 'clip' || cs.textOverflow === 'ellipsis';
    if (clips && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
      out.push({ check: 'overflow', message: 'clipped or overflowing box', detail: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') });
    }
  }
  // widow: a paragraph whose last line carries a single word
  const textTop = (paragraph, word) => {
    let offset = word.index;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (offset >= node.length) { offset -= node.length; continue; }
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, Math.min(offset + word[0].length, node.length));
      return range.getBoundingClientRect().top;
    }
    return null;
  };
  for (const p of document.querySelectorAll('p')) {
    const words = Array.from(p.textContent.matchAll(/\S+/g));
    if (words.length < 4) continue;
    const range = document.createRange();
    range.selectNodeContents(p);
    const rect = range.getBoundingClientRect();
    if (rect.height < 8) continue; // no meaningful lines
    const last = words[words.length - 1];
    const lastTop = textTop(p, last);
    const prevTop = textTop(p, words[words.length - 2]);
    if (lastTop !== null && prevTop !== null && Math.abs(lastTop - prevTop) > 4) {
      out.push({ check: 'widow', message: 'paragraph ends in a single-word line (widow)', detail: last[0] });
    }
  }
  // empty page: two forced page breaks with no content between them (computed style, not attribute)
  const breaks = [...document.querySelectorAll('body *')].filter(el => {
    const cs = getComputedStyle(el);
    return cs.breakAfter === 'page' || cs.breakBefore === 'page';
  });
  for (let k = 0; k + 1 < breaks.length; k++) {
    const a = breaks[k], b = breaks[k + 1];
    if (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const between = document.createRange();
      between.setStartAfter(a);
      between.setEndBefore(b);
      if (!between.toString().trim() && between.cloneContents().querySelectorAll('img, table, figure').length === 0) {
        out.push({ check: 'empty-page', message: 'a forced page break is immediately followed by another (empty page)' });
      }
    }
  }
  return out;
})()
