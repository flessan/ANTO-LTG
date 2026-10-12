(() => {
  const root = document.documentElement.dataset.root || './';
  const nav = [
    ['Home', 'index.html', 'home'],
    ['Drivers', 'drivers/', 'drivers'],
    ['Software', 'software/', 'software'],
    ['Bundles', 'bundles/', 'bundles'],
    ['Tools', 'tools/', 'tools'],
    ['Panduan', 'guides/', 'guides'],
    ['Developer', 'developers/', 'developers']
  ];
  const current = document.body.dataset.page || 'home';
  document.querySelectorAll('[data-site-nav]').forEach(navHost => {
    navHost.innerHTML = nav.map(([label, href, key]) =>
      `<a class="nav-link${key === current ? ' is-active' : ''}" href="${root + href}"${key === current ? ' aria-current="page"' : ''}>${label}</a>`
    ).join('');
  });
  const menuButton = document.querySelector('[data-menu-button]');
  const mobileNav = document.querySelector('[data-mobile-nav]');
  if (menuButton && mobileNav) {
    menuButton.addEventListener('click', () => {
      const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
      menuButton.setAttribute('aria-expanded', String(!isOpen));
      mobileNav.hidden = isOpen;
    });
  }
  document.querySelectorAll('[data-root-link]').forEach(link => {
    link.href = root + link.dataset.rootLink;
  });
  const year = document.querySelector('[data-year]');
  if (year) year.textContent = new Date().getFullYear();
})();
