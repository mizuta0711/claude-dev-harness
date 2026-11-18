(options = {}) => {
  // ブラウザの中で動く測定。browser-tester が本文を読み、Playwright MCP の browser_evaluate に渡す。
  // import も外の変数も使わない 1 つの関数式にする。合否は決めず、判断の材料の数値だけを返す。
  // 開発サーバでは意味が薄い速さの数値と、スクリプトで取れない操作回数は測らない。
  const CONTROLS = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="tab"],[role="link"]';
  const SHARED_PARTS = 'header,nav,footer,aside,[role="banner"],[role="navigation"],[role="contentinfo"],[role="complementary"]';
  const BAND_PX = 40;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const root = document.documentElement;
  const round = (value) => Number(value.toFixed(2));
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  // 読み上げ専用（sr-only）のように 1px 以下へ切り抜かれた要素は、画面の内容として数えない
  const isClipped = (el) => {
    for (let cur = el; cur !== null && cur !== document.body; cur = cur.parentElement) {
      const rect = cur.getBoundingClientRect();
      if ((rect.width <= 1 || rect.height <= 1) && getComputedStyle(cur).overflow !== 'visible') return true;
    }
    return false;
  };
  const nameOf = (el) => {
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => (id === '' ? '' : (document.getElementById(id)?.textContent ?? '')))
      .join(' ')
      .trim();
    const value = el.tagName === 'INPUT' ? el.value : '';
    return (el.getAttribute('aria-label') || labelledBy || value || el.textContent || '').trim();
  };
  const scope = document.querySelector(options.scope ?? 'main') ?? document.body;
  // main が無い画面では、共通のヘッダーやサイドバーを本文に数えない
  const inContent = (el) => scope !== document.body || el.closest(SHARED_PARTS) === null;
  const controls = [...document.querySelectorAll(CONTROLS)].filter((el) => isVisible(el) && !isClipped(el));

  // 表示領域と、はみ出しを隠す親で切り抜いた横の範囲（省略表示・カルーセル・画面外の要素を実際より広く数えない）
  const clips = new Map();
  const clipOf = (el) => {
    if (el === null || el === root) return { left: 0, right: viewportWidth };
    if (clips.has(el)) return clips.get(el);
    const parent = clipOf(el.parentElement);
    let clip = parent;
    if (getComputedStyle(el).overflowX !== 'visible') {
      const rect = el.getBoundingClientRect();
      clip = { left: Math.max(parent.left, rect.left), right: Math.min(parent.right, rect.right) };
    }
    clips.set(el, clip);
    return clip;
  };

  // 枠ではなく、文字・画像・操作部品が広がる幅を、縦の帯ごとに測る。
  // 全体の左右の端だと、見出し行だけ全幅の画面で、本文の横幅の余りが隠れる
  const bands = new Map();
  const extend = (rect, el) => {
    const clip = clipOf(el);
    const left = Math.max(rect.left, clip.left);
    const right = Math.min(rect.right, clip.right);
    if (right <= left || rect.height <= 0) return;
    const first = Math.floor((rect.top + window.scrollY) / BAND_PX);
    const last = Math.floor((rect.bottom + window.scrollY - 1) / BAND_PX);
    for (let band = first; band <= last; band += 1) {
      const cur = bands.get(band);
      bands.set(band, cur === undefined ? { left, right } : { left: Math.min(cur.left, left), right: Math.max(cur.right, right) });
    }
  };
  let minFontPx = null;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || (node.textContent ?? '').trim() === '' || !isVisible(parent) || isClipped(parent) || !inContent(parent)) continue;
    if (/^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(parent.tagName)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) extend(rect, parent);
    const fontPx = Number.parseFloat(getComputedStyle(parent).fontSize);
    minFontPx = minFontPx === null ? fontPx : Math.min(minFontPx, fontPx);
  }
  for (const el of scope.querySelectorAll(`img,svg,canvas,video,${CONTROLS}`)) {
    if (isVisible(el) && !isClipped(el) && inContent(el)) extend(el.getBoundingClientRect(), el);
  }
  // 短いラベルだけの行に引きずられないよう、中央値ではなく上位 4 分の 1 の位置を採る
  const widths = [...bands.values()].map((band) => band.right - band.left).sort((a, b) => a - b);
  const contentWidth = widths.length === 0 ? 0 : widths[Math.floor(widths.length * 0.75)];

  // 縦に重なって並ぶ、ある程度大きい子の数の最大を列数とする（表示領域に見えている分だけ）
  const boxesOf = (parent) =>
    [...parent.children].flatMap((child) => {
      if (getComputedStyle(child).display === 'contents') return boxesOf(child);
      return isVisible(child) ? [child.getBoundingClientRect()] : [];
    });
  let columns = widths.length === 0 ? 0 : 1;
  for (const parent of [scope, ...scope.querySelectorAll('*')]) {
    if (!inContent(parent) || (getComputedStyle(parent).display !== 'contents' && !isVisible(parent))) continue;
    const clip = clipOf(parent);
    const boxes = boxesOf(parent)
      .filter((rect) => rect.height >= 48 && Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left) >= 120)
      .sort((a, b) => a.top - b.top);
    boxes.forEach((box, index) => {
      let count = 1;
      for (let i = index + 1; i < boxes.length && boxes[i].top < box.bottom; i += 1) {
        const overlap = Math.min(box.bottom, boxes[i].bottom) - boxes[i].top;
        if (overlap >= Math.min(box.height, boxes[i].height) / 2) count += 1;
      }
      columns = Math.max(columns, count);
    });
  }

  // 本文が内側の領域でスクロールする画面は、ページ全体の高さが 1 画面分に見えるので、その領域の長さも見る。
  // サイドバー・入力欄・小さな一覧のスクロールは、本文の長さではないので数えない
  const rootClipsBody = getComputedStyle(root).overflowY !== 'visible';
  let innerScrollHeight = 0;
  for (const el of [document.body, ...document.body.querySelectorAll('*')]) {
    if (el.scrollHeight <= el.clientHeight + 1 || el.clientHeight < viewportHeight / 2 || el.tagName === 'TEXTAREA') continue;
    if (el === document.body && !rootClipsBody) continue;
    if (!(el.contains(scope) || scope.contains(el)) || !inContent(el) || !isVisible(el)) continue;
    if (/^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY)) innerScrollHeight = Math.max(innerScrollHeight, el.scrollHeight);
  }

  // 大きさを見るのは本文の中の押せる部品だけ。文中のリンクは対象にしない。
  // チェックボックスなどは、紐づくラベル全体が押せる範囲になる
  const sizeOf = (rect) => Math.min(rect.width, rect.height);
  const targets = controls
    .filter((el) => scope.contains(el) && inContent(el) && !el.disabled && !(el.tagName === 'A' && getComputedStyle(el).display === 'inline'))
    .map((el) => {
      const labels = el.matches('input[type="checkbox"],input[type="radio"]') ? [...el.labels] : [];
      return { el, size: Math.max(sizeOf(el.getBoundingClientRect()), ...labels.map((label) => sizeOf(label.getBoundingClientRect()))) };
    })
    .sort((a, b) => a.size - b.size);

  // 主要な操作: 未指定は null、指定したのに見えないときは 'not-found'。入力前で disabled でも、見えていれば判定する。
  // 本文の中を先に、完全一致を先に探す（ナビの「保存済み」を「保存」と取り違えない）
  const findByText = (text) => {
    const inScope = controls.filter((el) => scope.contains(el));
    return (
      inScope.find((el) => nameOf(el) === text) ??
      controls.find((el) => nameOf(el) === text) ??
      inScope.find((el) => nameOf(el).includes(text)) ??
      controls.find((el) => nameOf(el).includes(text)) ??
      null
    );
  };
  const primaryRequested = Boolean(options.primary || options.primaryText);
  const primary = (options.primary ? document.querySelector(options.primary) : null) ?? (options.primaryText ? findByText(options.primaryText) : null);
  const primaryRect = primary !== null && isVisible(primary) ? primary.getBoundingClientRect() : null;
  const primaryInFirstScreen = !primaryRequested
    ? null
    : primaryRect === null
      ? 'not-found'
      : primaryRect.bottom + window.scrollY <= viewportHeight;

  return {
    viewport: `${viewportWidth}x${viewportHeight}`,
    contentWidthRatio: round(contentWidth / viewportWidth),
    pageScreens: round(Math.max(root.scrollHeight, innerScrollHeight) / viewportHeight),
    innerScroll: innerScrollHeight > 0,
    columns,
    horizontalOverflowPx: Math.max(0, root.scrollWidth - root.clientWidth),
    primaryInFirstScreen,
    minFontPx,
    minButtonPx: targets.length === 0 ? null : round(targets[0].size),
    smallestButton: targets.length === 0 ? null : `${targets[0].el.tagName.toLowerCase()}「${nameOf(targets[0].el).slice(0, 30)}」`,
  };
}
