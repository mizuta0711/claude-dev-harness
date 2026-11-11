/* ============================================================
   配布サイトとマニュアルの動き（外部ファイルは読まない。file:/// でも動く）
   - Loads downloads.json (version manifest)
   - Renders the latest download + version history
   - Screenshot placeholder fallback + lightbox
   ============================================================ */

(function () {
  "use strict";

  // ---- Footer year ----
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // ---- Screenshot placeholder fallback ----
  // If a screenshot PNG is missing, show the styled placeholder instead of a broken image.
  document.querySelectorAll(".shot-link img").forEach(function (img) {
    img.addEventListener("error", function () {
      var link = img.closest(".shot-link");
      if (link) link.classList.add("is-missing");
    });
    // Already failed before listener attached (cached)
    if (img.complete && img.naturalWidth === 0) {
      var link = img.closest(".shot-link");
      if (link) link.classList.add("is-missing");
    }
  });

  // ---- Lightbox ----
  var lightbox = document.createElement("div");
  lightbox.className = "lightbox";
  lightbox.innerHTML =
    '<button class="lightbox-close" aria-label="閉じる">&times;</button><img alt="" />';
  document.body.appendChild(lightbox);
  var lightboxImg = lightbox.querySelector("img");

  function openLightbox(src, alt) {
    lightboxImg.src = src;
    lightboxImg.alt = alt || "";
    lightbox.classList.add("open");
  }
  function closeLightbox() {
    lightbox.classList.remove("open");
    lightboxImg.src = "";
  }

  document.querySelectorAll("[data-lightbox]").forEach(function (link) {
    link.addEventListener("click", function (e) {
      // Don't open the lightbox for missing screenshots
      if (link.classList.contains("is-missing")) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      var img = link.querySelector("img");
      openLightbox(link.getAttribute("href"), img ? img.alt : "");
    });
  });

  lightbox.addEventListener("click", function (e) {
    if (e.target === lightbox || e.target.classList.contains("lightbox-close")) {
      closeLightbox();
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeLightbox();
  });

  // ---- Downloads manifest ----
  var latestEl = document.getElementById("download-latest");
  var historyEl = document.getElementById("version-history");
  var listEl = document.getElementById("version-list");

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var KIND_LABEL = { bundled: "ランタイムあり", noruntime: "ランタイムなし" };
  // 種類の表示名（HTML に入れるので escape 済みで返す）
  function kindLabel(kind) {
    var text = Object.prototype.hasOwnProperty.call(KIND_LABEL, kind) ? KIND_LABEL[kind] : String(kind);
    return escapeHtml(text);
  }

  function formatSize(n) {
    if (!n) return "";
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function fileUrl(f) { return "downloads/" + encodeURIComponent(f.name); }

  function renderFileBlock(f, primary) {
    var label = kindLabel(f.kind);
    var size = formatSize(f.size);
    var sha = f.sha256
      ? '<p class="dl-sha">SHA-256（' + label + "）: " + escapeHtml(f.sha256) + "</p>"
      : '<p class="dl-sha">SHA-256（' + label + "）: 公開時に表示します</p>";
    var btn = '<a class="btn ' + (primary ? "btn-primary" : "btn-ghost") + '" href="' + escapeHtml(fileUrl(f)) + '" download>' +
      "<span>" + label + "版をダウンロード</span></a>";
    return '<div class="dl-noruntime">' +
      '<span class="dl-nr-label">' + label + "版" + (size ? ' <span class="dl-nr-size">' + escapeHtml(size) + "</span>" : "") + "</span>" +
      '<span class="dl-nr-note">' + escapeHtml(f.name) + "</span>" + btn + "</div>" + sha;
  }

  function renderLatest(v) {
    var notesHtml = "";
    if (v.notes && v.notes.length) {
      notesHtml =
        '<div class="dl-notes"><h4>このバージョンの変更点</h4><ul>' +
        v.notes.map(function (n) { return "<li>" + escapeHtml(n) + "</li>"; }).join("") +
        "</ul></div>";
    }
    var files = (v.files || []).slice().sort(function (a, b) {
      return (a.kind === "bundled" ? 0 : 1) - (b.kind === "bundled" ? 0 : 1);
    });
    var filesHtml = files.map(function (f, i) { return renderFileBlock(f, i === 0); }).join("");
    latestEl.innerHTML =
      '<div class="dl-top">' +
        '<div class="dl-version-block">' +
          '<span class="dl-badge">最新版</span>' +
          '<div class="dl-version">v' + escapeHtml(v.version) + ' <small>Windows x64</small></div>' +
          '<p class="dl-meta">' + escapeHtml(v.date || "") + "</p>" +
        "</div>" +
      "</div>" +
      filesHtml +
      notesHtml;
  }

  function renderHistory(versions) {
    if (!versions.length) {
      historyEl.hidden = true;
      return;
    }
    listEl.innerHTML = versions
      .map(function (v) {
        var actions = (v.files || []).map(function (f) {
          return '<a class="btn btn-ghost btn-sm" href="' + escapeHtml(fileUrl(f)) + '" download>' +
            kindLabel(f.kind) + "</a>";
        }).join("");
        return (
          '<div class="version-row">' +
            '<div class="vr-info"><span class="vr-version">v' + escapeHtml(v.version) + "</span>" +
              '<span class="vr-date">' + escapeHtml(v.date || "") + "</span></div>" +
            '<div class="vr-actions">' + actions + "</div>" +
          "</div>"
        );
      })
      .join("");
    historyEl.hidden = false;
  }

  function setHeroLatestLabel(version) {
    document.querySelectorAll("[data-latest-version]").forEach(function (el) {
      el.textContent = "v" + version;
    });
  }

  // ---- Mobile hamburger menu ----
  var navToggle = document.querySelector(".nav-toggle");
  var mobileMenu = document.getElementById("mobile-menu");
  if (navToggle && mobileMenu) {
    var setMenu = function (open) {
      mobileMenu.classList.toggle("open", open);
      navToggle.classList.toggle("open", open);
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    navToggle.addEventListener("click", function () {
      setMenu(!mobileMenu.classList.contains("open"));
    });
    mobileMenu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { setMenu(false); });
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 860) setMenu(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setMenu(false);
    });
  }

  // ---- Reveal on scroll ----
  var reveals = document.querySelectorAll(".reveal");
  if (reveals.length && "IntersectionObserver" in window) {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); ro.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -10% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { ro.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  // ---- Scroll-spy TOC ----
  var tocLinks = document.querySelectorAll(".toc a[href^='#']");
  if (tocLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    tocLinks.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
    var sections = document.querySelectorAll(".doc-section[id]");
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var link = byId[e.target.id];
        if (!link) return;
        if (e.isIntersecting) {
          tocLinks.forEach(function (l) { l.classList.remove("active"); });
          link.classList.add("active");
        }
      });
    }, { rootMargin: "-20% 0px -70% 0px" });
    sections.forEach(function (s) { spy.observe(s); });
  }

  // ---- Copy buttons on code blocks ----
  document.querySelectorAll(".code-block").forEach(function (block) {
    var pre = block.querySelector("pre");
    if (!pre) return;
    var btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.textContent = "コピー";
    btn.addEventListener("click", function () {
      var text = pre.innerText;
      var done = function () {
        btn.textContent = "コピーしました";
        btn.classList.add("done");
        setTimeout(function () { btn.textContent = "コピー"; btn.classList.remove("done"); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
    block.appendChild(btn);
  });

  // ---- Tabs ----
  document.querySelectorAll(".tabs").forEach(function (tabs) {
    var btns = tabs.querySelectorAll(".tab-btn");
    var panels = tabs.querySelectorAll(".tab-panel");
    btns.forEach(function (btn, i) {
      btn.addEventListener("click", function () {
        btns.forEach(function (b) { b.classList.remove("active"); });
        panels.forEach(function (p) { p.classList.remove("active"); });
        btn.classList.add("active");
        if (panels[i]) panels[i].classList.add("active");
      });
    });
  });

  // ---- Changelog page ----
  var changelogEl = document.getElementById("changelog-container");

  function renderChangelog(versions) {
    if (!versions.length) {
      changelogEl.innerHTML = '<p style="text-align:center;color:var(--text-mute)">変更履歴はありません。</p>';
      return;
    }
    var rows = versions.map(function (v) {
      var notesHtml = (v.notes && v.notes.length)
        ? '<ul class="cl-notes">' +
            v.notes.map(function (n) { return "<li>" + escapeHtml(n) + "</li>"; }).join("") +
          "</ul>"
        : '<p class="cl-no-notes">詳細なし</p>';
      return (
        '<div class="cl-entry">' +
          '<div class="cl-meta">' +
            '<span class="cl-version">v' + escapeHtml(v.version) + "</span>" +
            '<span class="cl-date">' + escapeHtml(v.date || "") + "</span>" +
          "</div>" +
          notesHtml +
        "</div>"
      );
    }).join("");
    changelogEl.innerHTML = '<div class="cl-list">' + rows + "</div>";
  }

  var heroLabels = document.querySelectorAll("[data-latest-version]");
  if (latestEl || heroLabels.length || changelogEl) fetch("downloads.json", { cache: "no-cache" })
    .then(function (res) {
      if (!res.ok) throw new Error("manifest " + res.status);
      return res.json();
    })
    .then(function (data) {
      var versions = (data.versions || []).slice();
      if (!versions.length) throw new Error("no versions");

      var latest = data.latest
        ? versions.filter(function (v) { return v.version === data.latest; })[0] || versions[0]
        : versions[0];

      setHeroLatestLabel(latest.version);

      if (latestEl) {
        renderLatest(latest);
        var rest = versions.filter(function (v) { return v.version !== latest.version; });
        renderHistory(rest);
      }

      if (changelogEl) renderChangelog(versions);
    })
    .catch(function () {
      if (latestEl) latestEl.innerHTML =
        '<p class="dl-loading">ダウンロード情報を読み込めませんでした。' +
        "しばらくしてから再度お試しください。</p>";
      if (changelogEl) changelogEl.innerHTML =
        '<p style="text-align:center;color:var(--text-mute)">変更履歴を読み込めませんでした。</p>';
    });
  // ---- Manual sidebar: inject + active link + accordion + mobile toggle ----
  // サイドバー HTML はここだけで管理（全ページ共通。パスは CSS href から深さを検出。外部ファイルは取得しない）
  var manualSidebar = document.getElementById('manual-sidebar');
  if (manualSidebar) {
    // CSSリンクの相対パス depth から manual/ までのプレフィックスを計算
    // 例: "../../assets/css/style.css" → depth=2 → dep="../../" m="../../manual/"
    var cssLink = document.querySelector('link[rel="stylesheet"]');
    var cssHref = cssLink ? cssLink.getAttribute('href') : '';
    var depth = (cssHref.match(/\.\.\//g) || []).length;
    var dep = depth > 0 ? Array(depth).fill('..').join('/') + '/' : './';
    var m = dep + 'manual/';

    // 配布サイトのトップ（絶対リンクはこの 1 つだけ。ヘルプ窓では既定のブラウザで開く）
    manualSidebar.innerHTML =
      '<div class="manual-sidebar-header">' +
        '<a href="' + m + 'index.html" class="manual-brand">マニュアル</a>' +
        '<button class="manual-sidebar-close" id="manual-sidebar-close" aria-label="目次を閉じる">✕</button>' +
      '</div>' +
      // ---- 目次（ページを足したら、ここに 1 行足す。tools/check-web.mjs がリンク先の実在を見る）----
      '<div class="manual-nav-section">はじめに</div>' +
      '<a href="' + m + 'getting-started.html">はじめに（最初の 1 回）</a>' +
      '<a href="' + m + 'install.html">インストールと削除</a>' +
      '<div class="manual-nav-section">画面</div>' +
      '<a href="' + m + 'screens/main.html">メイン画面</a>' +
      '<div class="manual-nav-section">付録</div>' +
      '<a href="' + m + 'faq.html">よくある質問</a>' +
      '<a href="' + m + 'history.html">マニュアルの改訂履歴</a>' +
      '<div class="manual-nav-footer">' +
        '<a href="{{SITE_URL}}" rel="noopener">配布サイトのトップ</a>' +
      '</div>';

    // アクティブリンク: 末尾2セグメント比較（同名ファイルが別ディレクトリにないため衝突なし）
    var currentPath = location.pathname.replace(/\/$/, '') || '/index.html';
    manualSidebar.querySelectorAll('a').forEach(function (a) {
      var href = a.getAttribute('href');
      if (!href) return;
      var hrefPath = href.split('?')[0].replace(/\/$/, '');
      var hrefTail = hrefPath.split('/').slice(-2).join('/');
      var curTail  = currentPath.split('/').slice(-2).join('/');
      if (hrefTail && curTail && hrefTail === curTail) {
        a.classList.add('active');
      }
    });

    // モバイルトグル
    var menuBtn  = document.getElementById('manual-menu-btn');
    var closeBtn = document.getElementById('manual-sidebar-close');
    var overlay  = document.createElement('div');
    overlay.className = 'manual-overlay';
    document.body.appendChild(overlay);
    var setManualSidebar = function (open) {
      manualSidebar.classList.toggle('open', open);
      overlay.classList.toggle('open', open);
    };
    if (menuBtn)  menuBtn.addEventListener('click',  function () { setManualSidebar(true);  });
    if (closeBtn) closeBtn.addEventListener('click', function () { setManualSidebar(false); });
    overlay.addEventListener('click', function () { setManualSidebar(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setManualSidebar(false);
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 880) setManualSidebar(false);
    });

    // アコーディオン（localStorage で開閉状態をページをまたいで保持）
    // ルール: アクティブリンクを含むセクションは常に開く。手動操作した状態は記憶する。
    var STORAGE_KEY = 'manual-sidebar-collapsed';
    var savedState = {};
    try { savedState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) {}
    manualSidebar.querySelectorAll('.manual-nav-section').forEach(function (section) {
      var links = [];
      var next = section.nextElementSibling;
      while (next && !next.classList.contains('manual-nav-section') && !next.classList.contains('manual-nav-footer')) {
        links.push(next);
        next = next.nextElementSibling;
      }
      if (!links.length) return;
      var group = document.createElement('div');
      group.className = 'manual-nav-group';
      section.parentNode.insertBefore(group, links[0]);
      links.forEach(function (link) { group.appendChild(link); });
      var arrow = document.createElement('span');
      arrow.className = 'manual-nav-section-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '▾';
      section.appendChild(arrow);
      var sectionKey = section.textContent.replace('▾', '').trim();
      var hasActive = !!group.querySelector('.active');
      // アクティブセクションは強制オープン。それ以外は保存済み状態（デフォルト: 閉じる）
      var isCollapsed = hasActive ? false : (sectionKey in savedState ? savedState[sectionKey] : false);
      if (isCollapsed) {
        section.classList.add('collapsed');
        group.classList.add('collapsed');
      }
      // キーボードでも開閉できるように、見出しをボタンとして扱う
      section.setAttribute('role', 'button');
      section.setAttribute('tabindex', '0');
      section.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      function toggleSection() {
        section.classList.toggle('collapsed');
        group.classList.toggle('collapsed');
        var collapsed = section.classList.contains('collapsed');
        section.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        savedState[sectionKey] = collapsed;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedState)); } catch (e) {}
      }
      section.addEventListener('click', toggleSection);
      section.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleSection();
        }
      });
    });
  }
})();
