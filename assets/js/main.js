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

  // --- Hero wrapping ---
  function wrapHero() {
    if (!content) return;
    var children = Array.prototype.slice.call(content.childNodes);
    var idx = -1;
    for (var i = 0; i < children.length; i++) {
      if (children[i].nodeName === 'H2') { idx = i; break; }
    }
    if (idx <= 0) return;
    var hero = document.createElement('div');
    hero.className = 'hero';
    children.slice(0, idx).forEach(function (node) { hero.appendChild(node); });
    content.insertBefore(hero, content.firstChild);
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
      a.addEventListener('click', function () {
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
    if (active !== null && tocItems[active]) tocItems[active].classList.add('active');
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

  // --- Init ---
  wrapHero();
  generateTOC();
  wrapTables();
  addCopyButtons();
  setupFadeIn();

  window.addEventListener('scroll', updateProgressBar, { passive: true });
  window.addEventListener('scroll', toggleBackToTop,   { passive: true });
  window.addEventListener('scroll', updateScrollSpy,   { passive: true });

  updateProgressBar();
  toggleBackToTop();
  updateScrollSpy();

}());
