(function () {
  'use strict';

  var progressBar = document.getElementById('progress-bar');
  var backToTop   = document.getElementById('back-to-top');
  var menuToggle  = document.getElementById('menu-toggle');
  var sidebar     = document.getElementById('sidebar');
  var overlay     = document.getElementById('overlay');
  var tocList     = document.getElementById('toc-list');
  var content     = document.getElementById('content');

  // --- Progress bar ---
  function updateProgressBar() {
    var el  = document.documentElement;
    var pct = (window.scrollY / (el.scrollHeight - el.clientHeight)) * 100;
    if (progressBar) progressBar.style.width = Math.min(pct, 100) + '%';
  }

  // --- Back to top ---
  function toggleBackToTop() {
    if (!backToTop) return;
    backToTop.classList.toggle('show', window.scrollY > 400);
  }

  if (backToTop) {
    backToTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // --- Mobile sidebar ---
  function openSidebar() {
    if (sidebar)     sidebar.classList.add('open');
    if (overlay)     overlay.classList.add('show');
    if (menuToggle)  menuToggle.setAttribute('aria-expanded', 'true');
  }

  function closeSidebar() {
    if (sidebar)     sidebar.classList.remove('open');
    if (overlay)     overlay.classList.remove('show');
    if (menuToggle)  menuToggle.setAttribute('aria-expanded', 'false');
  }

  if (menuToggle) {
    menuToggle.addEventListener('click', function () {
      sidebar && sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    });
  }

  if (overlay) overlay.addEventListener('click', closeSidebar);

  // --- Hero wrapping with word stagger ---
  function wrapHero() {
    if (!content) return;
    var children = Array.prototype.slice.call(content.childNodes);
    var idx = -1;
    for (var i = 0; i < children.length; i++) {
      if (children[i].nodeName === 'H1') {
        var h1 = children[i];
        var rawWords = [];
        h1.childNodes.forEach(function (node) {
          if (node.nodeType === 3) {
            node.textContent.split(/\s+/).forEach(function (w) { if (w) rawWords.push(w); });
          } else {
            rawWords.push(node.cloneNode(true));
          }
        });
        h1.innerHTML = '';
        rawWords.forEach(function (word, wordIdx) {
          var span = document.createElement('span');
          if (typeof word === 'string') {
            span.textContent = word;
          } else {
            span.appendChild(word);
          }
          span.style.animationDelay = (wordIdx * 0.1) + 's';
          h1.appendChild(span);
          if (wordIdx < rawWords.length - 1) {
            h1.appendChild(document.createTextNode(' '));
          }
        });
      }
      if (children[i].nodeName === 'H2') { idx = i; break; }
    }
    if (idx <= 0) return;
    var hero = document.createElement('div');
    hero.className = 'hero';
    children.slice(0, idx).forEach(function (node) { hero.appendChild(node); });
    content.insertBefore(hero, content.firstChild);
  }

  // --- Smooth scroll with highlight flash ---
  function smoothScrollToHeading(id) {
    var target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('highlight-pulse');
    setTimeout(function () { target.classList.remove('highlight-pulse'); }, 600);
  }

  // --- TOC scroll sync ---
  function scrollTocIntoView(tocItem) {
    if (!tocItem || !sidebar) return;
    var sidebarToc = sidebar.querySelector('.sidebar-toc');
    if (!sidebarToc) return;
    var itemTop    = tocItem.offsetTop;
    var itemBottom = itemTop + tocItem.offsetHeight;
    var viewTop    = sidebarToc.scrollTop;
    var viewBottom = viewTop + sidebarToc.clientHeight;
    if (itemTop < viewTop + 40)             sidebarToc.scrollTop = itemTop - 40;
    else if (itemBottom > viewBottom - 40)  sidebarToc.scrollTop = itemBottom - sidebarToc.clientHeight + 40;
  }

  // --- TOC generation ---
  var headings = [];
  var tocItems = [];

  function generateTOC() {
    if (!tocList || !content) return;
    headings = Array.prototype.slice.call(content.querySelectorAll('h2, h3')).filter(function (h) {
      return !h.closest('.hero');
    });
    if (!headings.length) return;

    headings.forEach(function (h) {
      if (!h.id) {
        h.id = h.textContent.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
      }
      var li = document.createElement('li');
      if (h.nodeName === 'H3') li.classList.add('toc-h3');
      var a  = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      a.addEventListener('click', function (e) {
        e.preventDefault();
        smoothScrollToHeading(a.getAttribute('href').substring(1));
        if (window.innerWidth <= 768) closeSidebar();
      });
      li.appendChild(a);
      tocList.appendChild(li);
    });

    tocItems = Array.prototype.slice.call(tocList.querySelectorAll('li'));
  }

  // --- Scroll spy ---
  function updateScrollSpy() {
    if (!headings.length || !tocItems.length) return;
    var mid    = window.scrollY + window.innerHeight / 3;
    var active = null;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top + window.scrollY <= mid) active = i;
    }
    tocItems.forEach(function (li) { li.classList.remove('active'); });
    if (active !== null && tocItems[active]) {
      tocItems[active].classList.add('active');
      scrollTocIntoView(tocItems[active]);
    }
  }

  // --- Fade-in observer ---
  function setupFadeIn() {
    if (!content || !window.IntersectionObserver) return;
    var targets = Array.prototype.slice.call(content.querySelectorAll('h2, h3')).filter(function (h) {
      return !h.closest('.hero');
    });
    targets.forEach(function (h) { h.classList.add('will-fade'); });
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('fade-in');
          obs.unobserve(e.target);
        }
      });
    }, { threshold: 0.1 });
    targets.forEach(function (h) { obs.observe(h); });
  }

  // --- Copy buttons ---
  function addCopyButtons() {
    if (!content) return;
    content.querySelectorAll('pre').forEach(function (pre) {
      var btn       = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', function () {
        var text = (pre.querySelector('code') || pre).textContent;
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = '✓ Copied';
          btn.classList.add('copied');
          setTimeout(function () {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 2000);
        }).catch(function () {
          btn.textContent = 'Error';
          setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
        });
      });
      pre.appendChild(btn);
    });
  }

  // --- Table wrapping ---
  function wrapTables() {
    if (!content) return;
    content.querySelectorAll('table').forEach(function (table) {
      if (table.parentElement.classList.contains('table-wrap')) return;
      var wrap       = document.createElement('div');
      wrap.className = 'table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  // --- Anchor links ---
  function addAnchorLinks() {
    if (!content) return;
    content.querySelectorAll('h2, h3').forEach(function (h) {
      if (h.closest('.hero')) return;
      var link = document.createElement('a');
      link.className   = 'anchor-link';
      link.href        = '#' + h.id;
      link.textContent = '#';
      link.setAttribute('aria-label', 'Link to this section');
      link.addEventListener('click', function (e) {
        e.preventDefault();
        navigator.clipboard.writeText(window.location.href.split('#')[0] + '#' + h.id).catch(function () {});
        smoothScrollToHeading(h.id);
      });
      h.appendChild(link);
    });
  }

  // --- External links ---
  function handleExternalLinks() {
    if (!content) return;
    var origin = window.location.origin;
    content.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith(origin)) return;
      if (href.startsWith('http')) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        if (!a.querySelector('.external-icon')) {
          var icon = document.createElement('span');
          icon.className   = 'external-icon';
          icon.textContent = '↗';
          icon.setAttribute('aria-hidden', 'true');
          a.appendChild(icon);
        }
      }
    });
  }

  // --- Reading time ---
  function addReadingTime() {
    if (!content) return;
    var text  = content.innerText || '';
    var words = text.trim().split(/\s+/).length;
    var mins  = Math.max(1, Math.round(words / 200));
    var firstH2 = Array.prototype.filter.call(
      content.querySelectorAll('h2'),
      function (h) { return !h.closest('.hero'); }
    )[0];
    if (!firstH2) return;
    var timeEl = document.createElement('div');
    timeEl.className   = 'reading-time';
    timeEl.textContent = '⏱ ' + mins + ' min read';
    firstH2.parentNode.insertBefore(timeEl, firstH2);
  }

  // --- Keyboard shortcuts modal ---
  function setupKeyboardShortcuts() {
    var modal = document.createElement('div');
    modal.className = 'shortcuts-modal';
    modal.innerHTML = '<div class="shortcuts-modal-box">' +
      '<h3>Keyboard Shortcuts</h3>' +
      '<div class="shortcut-row"><span>Show shortcuts</span><kbd>?</kbd></div>' +
      '<div class="shortcut-row"><span>Back to top</span><kbd>g</kbd></div>' +
      '<div class="shortcut-row"><span>Close</span><kbd>Esc</kbd></div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.classList.remove('show');
    });

    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '?' || e.key === '/') {
        e.preventDefault();
        modal.classList.toggle('show');
      }
      if (e.key === 'Escape') modal.classList.remove('show');
      if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  // --- Highlight install command ---
  function highlightInstallCommand() {
    if (!content) return;
    content.querySelectorAll('pre').forEach(function (pre) {
      var code = pre.querySelector('code');
      if (code && code.textContent.includes('uv tool install token-goat')) {
        pre.classList.add('install-highlight');
      }
    });
  }

  // --- Init ---
  wrapHero();
  generateTOC();
  wrapTables();
  addCopyButtons();
  setupFadeIn();
  addAnchorLinks();
  handleExternalLinks();
  addReadingTime();
  setupKeyboardShortcuts();
  highlightInstallCommand();

  window.addEventListener('scroll', updateProgressBar, { passive: true });
  window.addEventListener('scroll', toggleBackToTop,   { passive: true });
  window.addEventListener('scroll', updateScrollSpy,   { passive: true });

  updateProgressBar();
  toggleBackToTop();
  updateScrollSpy();

}());
