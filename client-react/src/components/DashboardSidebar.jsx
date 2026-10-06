import { useEffect, useState } from 'react';
import { NavLink, useNavigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function DashboardSidebar({ userName }) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const location = useLocation();
  // Mobile drawer (≤768px); the sidebar is always visible on larger screens.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  async function handleLogout() {
    try {
      await signOut();
    } finally {
      navigate('/');
    }
  }

  const navItemClass = ({ isActive }) => `nav-item${isActive ? ' active' : ''}`;

  return (
    <>
      <div className="sidebar-mobile-bar">
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Open navigation"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
        <Link to="/" className="logo-link">
          <img src="/assets/cp_bg.png" alt="CampusPrint Logo" className="sidebar-mobile-logo" />
        </Link>
      </div>
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-header">
          <Link to="/" className="logo-link">
            <img src="/assets/cp_bg.png" alt="CampusPrint Logo" className="sidebar-logo" />
          </Link>
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/dashboard" end className={navItemClass}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"></rect>
              <rect x="14" y="3" width="7" height="7"></rect>
              <rect x="14" y="14" width="7" height="7"></rect>
              <rect x="3" y="14" width="7" height="7"></rect>
            </svg>
            Dashboard
          </NavLink>
          <NavLink to="/new-order" className={navItemClass}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 6 2 18 2 18 9"></polyline>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
              <rect x="6" y="14" width="12" height="8"></rect>
            </svg>
            New Order
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar">{userName ? userName.charAt(0).toUpperCase() : 'U'}</div>
            <div className="user-details">
              <span className="user-name">{userName || 'Loading…'}</span>
              <span className="user-role">Student</span>
            </div>
          </div>
          <button className="logout-btn" onClick={handleLogout}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}
