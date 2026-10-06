import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import '../../styles/admin-effects.css';

const ICONS = {
  grid: <><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></>,
  doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></>,
  clock: <><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></>,
  check: <polyline points="20 6 9 17 4 12"></polyline>,
  printer: <><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></>,
  bag: <><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></>,
  checkcircle: <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></>,
  x: <><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></>,
  wallet: <><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"></path><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"></path><path d="M18 12a2 2 0 0 0 0 4h4v-4z"></path></>,
  list: <><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></>,
  shop: <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></>,
  gear: <><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></>,
};

function Icon({ name, className = 'h-[17px] w-[17px]' }) {
  return (
    <svg className={`flex-shrink-0 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

const ADMIN_NAV = [
  { key: 'dashboard', label: 'Dashboard', path: '/admin', icon: 'grid', exact: true },
  {
    group: 'Orders',
    items: [
      { key: 'orders', label: 'All Orders', path: '/admin/orders', status: null, icon: 'doc' },
      { key: 'orders-pending', label: 'Pending Orders', path: '/admin/orders', status: 'pending', icon: 'clock' },
      { key: 'orders-accepted', label: 'Accepted Orders', path: '/admin/orders', status: 'accepted', icon: 'check' },
      { key: 'orders-printing', label: 'Printing', path: '/admin/orders', status: 'printing', icon: 'printer' },
      { key: 'orders-ready', label: 'Ready for Pickup', path: '/admin/orders', status: 'ready', icon: 'bag' },
      { key: 'orders-completed', label: 'Completed', path: '/admin/orders', status: 'completed', icon: 'checkcircle' },
      { key: 'orders-rejected', label: 'Rejected / Cancelled', path: '/admin/orders', status: 'rejected', icon: 'x' },
    ],
  },
  {
    group: 'Earnings',
    items: [
      { key: 'earnings', label: 'Earnings', path: '/admin/earnings', icon: 'wallet' },
      { key: 'transactions', label: 'Transactions', path: '/admin/transactions', icon: 'list' },
    ],
  },
  {
    group: 'Shop',
    items: [
      { key: 'shop-profile', label: 'Shop Profile', path: '/admin/shop-profile', icon: 'shop' },
      { key: 'settings', label: 'Settings', path: '/admin/settings', icon: 'gear' },
    ],
  },
];

function isNavItemActive(item, location) {
  if (item.exact) return location.pathname === item.path;
  if (item.path !== location.pathname) return false;
  if (item.status === undefined) return true;
  const currentStatus = new URLSearchParams(location.search).get('status') || null;
  return currentStatus === item.status;
}

const FLAT_ADMIN_NAV = ADMIN_NAV.flatMap((entry) => (entry.group ? entry.items : [entry]));

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeNavItem = FLAT_ADMIN_NAV.find((item) => isNavItemActive(item, location));
  const pageTitle = activeNavItem ? activeNavItem.label : 'Dashboard';
  const [checking, setChecking] = useState(true);
  const [profileName, setProfileName] = useState('Shop Owner');
  const [pendingCount, setPendingCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const chipRef = useRef(null);

  // Close the mobile drawer after navigating.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    let cancelled = false;

    async function guard() {
      try {
        const res = await fetch('/api/admin/status', { credentials: 'include' });
        const data = await res.json();
        if (!data.isLoggedIn) {
          navigate('/admin/login');
          return;
        }
        if (cancelled) return;
        setProfileName((data.email || '').split('@')[0]);
        try {
          const shopRes = await fetch('/api/admin/shop-profile', { credentials: 'include' });
          if (shopRes.ok) {
            const shop = await shopRes.json();
            if (!cancelled && shop && shop.shop_name) setProfileName(shop.shop_name);
          }
        } catch { /* keep fallback */ }

        try {
          const dashRes = await fetch('/api/admin/dashboard', { credentials: 'include' });
          if (dashRes.ok) {
            const dash = await dashRes.json();
            if (!cancelled && dash?.statusCounts?.pending !== undefined) {
              setPendingCount(dash.statusCounts.pending);
            }
          }
        } catch { /* silent */ }
      } catch {
        // network hiccup
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    guard();
    const interval = setInterval(guard, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [navigate]);

  useEffect(() => {
    function onDocClick(e) {
      if (chipRef.current && !chipRef.current.contains(e.target)) setDropdownOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  async function handleLogout(e) {
    if (e) e.preventDefault();
    try {
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' });
    } finally {
      navigate('/admin/login');
    }
  }

  if (checking) return null;

  return (
    <div className="admin-app-container">
      {/* Sidebar */}
      <aside className={`admin-sidebar ${sidebarOpen ? 'open' : ''}`}>
        {/* Brand Header */}
        <div className="admin-brand">
          <div className="admin-brand-icon">
            <Icon name="printer" className="h-5 w-5" />
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0b1120] bg-emerald-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="admin-brand-title">CAMPUS PRINT</h1>
            <span className="admin-brand-subtitle">Shop Admin Panel</span>
          </div>
        </div>

        {/* Nav links */}
        <nav className="admin-nav-section">
          {ADMIN_NAV.map((entry) =>
            entry.group ? (
              <div key={entry.group}>
                <div className="admin-nav-group-label">{entry.group}</div>
                {entry.items.map((item) => {
                  const active = isNavItemActive(item, location);
                  const isPendingLink = item.key === 'orders-pending';
                  return (
                    <Link
                      key={item.key}
                      to={item.status ? `${item.path}?status=${item.status}` : item.path}
                      className={`admin-nav-item ${active ? 'active' : ''}`}
                    >
                      <div className="flex items-center gap-3 min-w-0 truncate">
                        <Icon name={item.icon} className={`h-4 w-4 ${active ? 'text-white' : 'text-slate-400'}`} />
                        <span className="truncate">{item.label}</span>
                      </div>
                      {isPendingLink && pendingCount > 0 && (
                        <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-500 px-1.5 text-[0.68rem] font-bold text-slate-950 shadow-sm flex-shrink-0">
                          {pendingCount}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            ) : (
              <Link
                key={entry.key}
                to={entry.path}
                className={`admin-nav-item ${isNavItemActive(entry, location) ? 'active' : ''}`}
              >
                <div className="flex items-center gap-3 min-w-0 truncate">
                  <Icon name={entry.icon} className={`h-4 w-4 ${isNavItemActive(entry, location) ? 'text-white' : 'text-slate-400'}`} />
                  <span className="truncate">{entry.label}</span>
                </div>
              </Link>
            )
          )}
        </nav>

        {/* Footer Profile & Logout */}
        <div className="admin-sidebar-footer">
          <div className="admin-user-card">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600/30 text-blue-400 font-bold text-xs flex-shrink-0">
              {profileName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-bold text-white capitalize">{profileName}</div>
              <div className="flex items-center gap-1.5 text-[0.66rem] text-emerald-400 font-semibold">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>Shop Active</span>
              </div>
            </div>
          </div>

          <button onClick={handleLogout} className="admin-logout-btn">
            <Icon name="logout" className="h-4 w-4" />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Overlay for mobile drawer */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-[55] bg-slate-950/60 backdrop-blur-sm admin-overlay-in md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main Content Wrapper */}
      <div className="admin-main-wrapper">
        <header className="admin-header">
          <div className="flex min-w-0 items-center gap-4 max-md:gap-3">
            <button
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition hover:border-blue-500 hover:bg-blue-50 hover:text-blue-600 md:hidden"
              onClick={() => setSidebarOpen(true)}
              title="Toggle Navigation"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </button>
            <h1 className="admin-header-title">{pageTitle}</h1>
          </div>

          <div className="flex flex-shrink-0 items-center gap-4" ref={chipRef}>
            {/* Live Indicator */}
            <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 max-sm:hidden">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Live Store</span>
            </div>

            {/* Profile Menu Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setDropdownOpen((v) => !v); }}
                className="admin-profile-chip"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-bold text-xs shadow-sm">
                  {profileName.charAt(0).toUpperCase()}
                </div>
                <div className="flex flex-col text-left leading-tight max-md:hidden pr-1">
                  <span className="text-xs font-bold text-slate-900 capitalize">{profileName}</span>
                  <span className="text-[0.65rem] text-slate-500 font-semibold">Shop Admin</span>
                </div>
                <svg className="h-3.5 w-3.5 text-slate-400 max-md:hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>

              {dropdownOpen && (
                <div className="admin-dropdown-menu">
                  <Link
                    to="/admin/shop-profile"
                    onClick={() => setDropdownOpen(false)}
                    className="admin-dropdown-item"
                  >
                    <Icon name="shop" className="h-4 w-4" />
                    <span>Shop Profile</span>
                  </Link>
                  <Link
                    to="/admin/settings"
                    onClick={() => setDropdownOpen(false)}
                    className="admin-dropdown-item"
                  >
                    <Icon name="gear" className="h-4 w-4" />
                    <span>Account Settings</span>
                  </Link>
                  <div className="my-1 border-t border-slate-100" />
                  <a
                    href="#"
                    onClick={handleLogout}
                    className="admin-dropdown-item danger"
                  >
                    <Icon name="logout" className="h-4 w-4" />
                    <span>Logout</span>
                  </a>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="admin-content-body">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
