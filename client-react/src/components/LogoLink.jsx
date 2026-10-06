import { Link } from 'react-router-dom';

export default function LogoLink({ className = '', style = {} }) {
  return (
    <Link to="/" className={`logo-link logo-link--floating ${className}`} style={{
      position: 'absolute',
      top: '2rem',
      left: '2rem',
      zIndex: 10,
      ...style
    }}>
      <img
        src="/cp.png"
        alt="CampusPrint Logo"
        style={{ height: '40px', width: 'auto', display: 'block', objectFit: 'contain' }}
      />
    </Link>
  );
}
