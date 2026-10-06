import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import PageBackground from '../components/PageBackground';
import SocialLinks from '../components/SocialLinks';
import Footer from '../components/Footer';
import useBodyClass from '../lib/useBodyClass';
import useDocumentTitle from '../lib/useDocumentTitle';
import '../styles/style.css';
import '../styles/about.css';

export default function About() {
  useBodyClass('about-page');
  useDocumentTitle('About Us – Print Campus');

  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/@phosphor-icons/web';
    script.defer = true;
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);

  return (
    <>
      <PageBackground />
      <div className="page-content">

        <header className="top-nav about-nav">
          <nav>
            <Link to="/" className="nav-link">Home</Link>
            <Link to="/about" className="nav-link nav-link--active">About Us</Link>
            <a href="/#location-section" className="nav-link">Location</a>
          </nav>
        </header>

        <section className="about-hero">
          <div className="about-hero__content">
            <span className="about-badge">Meet the Team</span>
            <h1 className="about-hero__title">
              The Minds Behind<br /><span className="about-hero__highlight">Print Campus</span>
            </h1>
            <p className="about-hero__subtitle">
              Two students on a mission — making printing on campus fast,<br />
              affordable, and completely hassle-free.
            </p>
          </div>

          <div className="blob blob--1" />
          <div className="blob blob--2" />
          <div className="blob blob--3" />
        </section>

        <section className="team-section">
          <div className="team-grid">

            <article className="team-card" id="card-1">
              <div className="card-glow" />
              <div className="card-inner">
                <div className="card-avatar-wrap">
                  <img
                    className="card-avatar"
                    src="/assets/member1.jpg"
                    alt="Ankit Chaurasia"
                    onError={(e) => { e.currentTarget.src = 'https://api.dicebear.com/8.x/notionists/svg?seed=AnkitChaurasia&backgroundColor=b6e3f4'; }}
                  />
                  <div className="card-avatar-ring" />
                </div>

                <div className="card-body">
                  <h2 className="card-name">Ankit Chaurasia</h2>
                  <p className="card-role">Founder &amp; Designer</p>
                  <p className="card-desc">
                    Obsessed with great design and smooth user experiences.
                    Brings the visual side to life — from branding to every pixel on this page.
                  </p>

                  <div className="card-divider" />

                  <SocialLinks
                    links={[
                      { platform: 'instagram', href: 'https://www.instagram.com/ankit.95_?igsh=MTlyaDVxemc4dmVmNA==', label: '@ankit.95_' },
                      { platform: 'linkedin', href: 'https://www.linkedin.com/in/ankit-chaurasia-ab126239b/', label: 'Ankit Chaurasia' },
                      { platform: 'github', href: 'https://github.com/gta2dvice', label: 'gta2dvice' },
                    ]}
                  />
                </div>
              </div>
            </article>

            <article className="team-card" id="card-2">
              <div className="card-glow card-glow--2" />
              <div className="card-inner">
                <div className="card-avatar-wrap">
                  <img
                    className="card-avatar"
                    src="/assets/member2.jpg"
                    alt="Atishay Jain"
                    onError={(e) => { e.currentTarget.src = 'https://api.dicebear.com/8.x/notionists/svg?seed=AtishayJain&backgroundColor=ffd5dc'; }}
                  />
                  <div className="card-avatar-ring card-avatar-ring--2" />
                </div>

                <div className="card-body">
                  <h2 className="card-name">Atishay Jain</h2>
                  <p className="card-role">Co-Founder &amp; Developer</p>
                  <p className="card-desc">
                    Passionate about building tools that actually solve real student problems.
                    Handles the tech, the servers, and anything that involves code.
                  </p>

                  <div className="card-divider" />

                  <SocialLinks
                    links={[
                      { platform: 'instagram', href: 'https://www.instagram.com/miraculous.jain_16?igsh=MTY3N3Vnbjk1Mms4cA==', label: '@miraculous.jain_16' },
                      { platform: 'linkedin', href: 'https://www.linkedin.com/in/atishay-jain-433594326/', label: 'Atishay Jain' },
                      { platform: 'github', href: 'https://github.com/PseudoCoder16', label: 'PseudoCoder16' },
                    ]}
                  />
                </div>
              </div>
            </article>

          </div>
        </section>
        <Footer />
      </div>
    </>
  );
}
