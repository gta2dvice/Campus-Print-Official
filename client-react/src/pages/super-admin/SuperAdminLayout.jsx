import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import Icon from './Icon';
import '../../styles/super-admin-effects.css';

const SUPER_NAV = [
  { key: 'dashboard', label: 'Dashboard', to: '/super-admin', end: true, icon: 'grid' },
  { group: 'Users', items: [
    { key: 'users', label: 'Students / Users', to: '/super-admin/users', icon: 'users' },
  ] },
  { group: 'Shops', items: [
    { key: 'shops', label: 'Printing Shops', to: '/super-admin/shops', icon: 'shop' },
  ] },
  { group: 'Orders', items: [
    { key: 'orders', label: 'All Orders', to: '/super-admin/orders', icon: 'doc' },
  ] },
  { group: 'Payments', items: [
    { key: 'payments', label: 'Payments', to: '/super-admin/payments', icon: 'card' },
    { key: 'transactions', label: 'Transactions', to: '/super-admin/transactions', icon: 'list' },
    { key: 'payment-gateway', label: 'Payment Gateway', to: '/super-admin/payment-gateway', icon: 'plug' },
  ] },
  { group: 'Analytics', items: [
    { key: 'analytics', label: 'Analytics', to: '/super-admin/analytics', icon: 'chart' },
  ] },
  { group: 'Settings', items: [
    { key: 'settings', label: 'Platform Settings', to: '/super-admin/settings', icon: 'gear' },
  ] },
];

function navItemClass({ isActive }) {
  return `flex w-full items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-left text-[0.85rem] font-medium transition ${
    isActive ? 'bg-blue-500 text-white shadow-[0_2px_8px_rgba(59,130,246,0.3)]' : 'text-gray-600 hover:bg-blue-500/[0.08] hover:text-blue-500'
  }`;
}

export default function SuperAdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const flatNav = SUPER_NAV.flatMap((e) => (e.group ? e.items : [e]));
  const activeItem = flatNav.find((item) => (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)));
  const pageTitle = activeItem ? activeItem.label : 'Dashboard';
  const [authChecked, setAuthChecked] = useState(false);
  const [email, setEmail] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const chipRef = useRef(null);

  // Close the mobile drawer after navigating.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/super-admin/status', { credentials: 'include' });
        const data = await res.json();
        if (cancelled) return;
        if (!data.isLoggedIn) {
          navigate('/super-admin/login', { replace: true });
          return;
        }
        setEmail(data.email || '');
        setAuthChecked(true);
      } catch {
        // network hiccup — let the page render; API calls below will redirect on 401
        setAuthChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, [navigate]);

  useEffect(() => {
    function onDocClick() { setDropdownOpen(false); }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  async function doLogout(e) {
    e.preventDefault();
    try { await fetch('/api/super-admin/logout', { method: 'POST', credentials: 'include' }); }
    finally { navigate('/super-admin/login'); }
  }

  if (!authChecked) return null;

  return (
    <div className="min-h-screen bg-[linear-gradient(135deg,#f3f7fb_0%,#eaf1f7_100%)]">
      <div className="flex min-h-screen">
        <aside
          className={`sa-sidebar fixed left-0 top-0 z-[60] flex h-screen w-[264px] flex-col overflow-y-auto border-r border-[#f0f4f8] bg-white shadow-[0_4px_12px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] transition-transform duration-300 max-md:max-w-[85vw] max-md:-translate-x-full ${
            sidebarOpen ? 'max-md:translate-x-0' : ''
          }`}
        >
          <div className="flex items-center gap-3 border-b border-[#f0f4f8] px-5 py-6">
            <div className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#3b82f6,#2563eb)] text-[0.85rem] font-bold text-white shadow-[0_2px_8px_rgba(59,130,246,0.35)]">CP</div>
            <div>
              <span className="block text-[0.92rem] font-extrabold tracking-wide text-gray-900">CAMPUS PRINT</span>
              <span className="block text-[0.7rem] font-medium text-gray-400">Super Admin</span>
            </div>
          </div>

          <nav className="flex flex-1 flex-col gap-[0.2rem] p-3">
            {SUPER_NAV.map((entry) =>
              entry.group ? (
                <div key={entry.group}>
                  <div className="px-3.5 pb-[0.3rem] pt-[0.9rem] text-[0.68rem] font-bold uppercase tracking-wider text-gray-400">{entry.group}</div>
                  {entry.items.map((item) => (
                    <NavLink key={item.key} to={item.to} className={navItemClass}>
                      <Icon name={item.icon} />
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              ) : (
                <NavLink key={entry.key} to={entry.to} end={entry.end} className={navItemClass}>
                  <Icon name={entry.icon} />
                  {entry.label}
                </NavLink>
              )
            )}
          </nav>

          <div className="border-t border-[#f0f4f8] p-3">
            <a
              href="#"
              onClick={doLogout}
              className="flex w-full items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-[0.85rem] font-medium text-gray-600 transition hover:bg-red-500/[0.08] hover:text-red-500"
            >
              <Icon name="logout" />
              Logout
            </a>
          </div>
        </aside>

        <div className="ml-[264px] flex min-h-screen min-w-0 flex-1 flex-col max-md:ml-0">
          <header className="sticky top-0 z-40 flex h-[68px] items-center justify-between gap-3 border-b border-gray-300/50 bg-white/85 px-8 backdrop-blur-md max-md:px-4">
            <div className="flex min-w-0 items-center gap-4 max-md:gap-3">
              <button
                className="hidden h-[38px] w-[38px] flex-shrink-0 items-center max-md:h-10 max-md:w-10 justify-center rounded-[10px] border border-gray-200 text-gray-600 transition hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500 max-md:flex"
                title="Menu"
                onClick={() => setSidebarOpen(true)}
              >
                <Icon name="menu" className="h-[18px] w-[18px]" />
              </button>
              <h1 className="truncate text-[1.15rem] font-bold tracking-tight text-gray-900 max-md:text-base">
                {pageTitle}
              </h1>
            </div>
            <div className="flex items-center gap-3">
              <div
                ref={chipRef}
                className="relative flex cursor-pointer items-center gap-2.5 rounded-full border border-gray-200 py-[0.35rem] pl-[0.35rem] pr-[0.7rem] transition hover:border-blue-500"
                onClick={(e) => { e.stopPropagation(); setDropdownOpen((v) => !v); }}
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#3b82f6,#2563eb)] text-[0.75rem] font-bold text-white">CP</div>
                <div className="flex flex-col leading-tight max-md:hidden">
                  <span className="text-[0.82rem] font-semibold capitalize text-gray-900">{email ? email.split('@')[0] : 'Loading…'}</span>
                  <span className="text-[0.68rem] text-gray-400">Super Admin</span>
                </div>
                <Icon name="chevron" className="h-3.5 w-3.5 text-gray-400 max-md:hidden" />
                {dropdownOpen && (
                  <div className="sa-animate-in absolute right-0 top-[calc(100%+8px)] z-50 min-w-[170px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-[0_10px_25px_rgba(0,0,0,0.08),0_4px_8px_rgba(0,0,0,0.04)]">
                    <a href="/super-admin/settings" className="block px-4 py-[0.65rem] text-[0.82rem] text-gray-600 hover:bg-blue-500/[0.08] hover:text-blue-500">Account Settings</a>
                    <a href="#" onClick={doLogout} className="block px-4 py-[0.65rem] text-[0.82rem] text-gray-600 hover:bg-blue-500/[0.08] hover:text-blue-500">Logout</a>
                  </div>
                )}
              </div>
            </div>
          </header>

          <main className="mx-auto w-full max-w-[1440px] flex-1 px-8 pb-10 pt-7 max-md:px-4 max-md:pt-5">
            <Outlet />
          </main>
        </div>

        {sidebarOpen && (
          <div className="fixed inset-0 z-[55] bg-gray-900/40 md:hidden" onClick={() => setSidebarOpen(false)} />
        )}
      </div>
    </div>
  );
}
