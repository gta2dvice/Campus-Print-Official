import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import '../styles/style.css';

export default function Footer() {
    const [isLoggedIn, setIsLoggedIn] = useState(false);

    useEffect(() => {
        let active = true;
        async function checkAuth() {
            try {
                const res = await fetch('/api/auth/status', { credentials: 'include' });
                const data = await res.json();
                if (active && data.isLoggedIn) {
                    setIsLoggedIn(true);
                }
            } catch {
                if (active) setIsLoggedIn(false);
            }
        }
        checkAuth();
        return () => { active = false; };
    }, []);

    return (
        <footer className="site-footer">
            <div className="footer-inner">
                <div className="footer-brand">
                    <span className="footer-logo">PRINT CAMPUS</span>
                    <p className="footer-tagline">Skip the queue. Print smarter.</p>
                </div>

                <div className="footer-links">
                    <div className="footer-col">
                        <h4>Navigate</h4>
                        {isLoggedIn ? (
                            <>
                                <Link to="/">Home</Link>
                                <Link to="/new-order">New Order</Link>
                                <Link to="/orders">My Orders</Link>
                                <Link to="/dashboard">My Dashboard</Link>
                            </>
                        ) : (
                            <>
                                <Link to="/">Home</Link>
                                <Link to="/orders">My Orders</Link>
                                <Link to="/register">Register</Link>
                            </>
                        )}
                    </div>
                    <div className="footer-col">
                        <h4>Connect</h4>
                        <a href="https://www.instagram.com/srm_campusprint?utm_source=ig_web_button_share_sheet&obrf=ZDNlZDc0MzIxNw==" target="_blank" rel="noreferrer">Instagram</a>
                        <a href="https://mail.google.com/mail/?view=cm&fs=1&to=orders%40campusprint.shop" target="_blank" rel="noreferrer">Email Us</a>
                    </div>
                </div>
            </div>
            <div className="footer-bottom">
                <p>© {new Date().getFullYear()} Campus Print. All rights reserved.</p>
            </div>
        </footer>
    );
}
