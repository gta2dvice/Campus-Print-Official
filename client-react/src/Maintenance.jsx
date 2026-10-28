import useBodyClass from './lib/useBodyClass';
import useDocumentTitle from './lib/useDocumentTitle';
import './Maintenance.css';

export default function Maintenance() {
  useBodyClass('maintenance-body');
  useDocumentTitle('Campus Print – On a Short Break');

  return (
    <div className="maintenance-wrapper">
      <div className="torn-blue">
        <main className="torn-paper">
          <span className="badge">On a short break</span>
          <h1>Campus<br />Print</h1>
          <p className="sub">
            We're taking a little vacation to recharge. Our website is closed for now,
            but we'll be back soon to print your ideas fast &amp; affordably.
          </p>
          <img
            className="photo"
            src="/vacation.png"
            alt="Jerry relaxing on a beach towel with sunglasses"
            onError={(e) => {
              if (!e.currentTarget.dataset.retried) {
                e.currentTarget.dataset.retried = 'true';
                e.currentTarget.src = '/vacation.jpg';
              }
            }}
          />
          <p className="note">See you soon! ☀️</p>
        </main>
      </div>
    </div>
  );
}
