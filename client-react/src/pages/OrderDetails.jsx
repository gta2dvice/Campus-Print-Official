import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Toast from '../components/Toast';
import useToast from '../lib/useToast';
import useBodyClass from '../lib/useBodyClass';
import useDocumentTitle from '../lib/useDocumentTitle';
import LogoLink from '../components/LogoLink';
import '../styles/style.css';

export default function OrderDetails() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { toast } = useToast();
    useBodyClass('app-body');
    useDocumentTitle('Order Details – Print Campus');

    const [order, setOrder] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function load() {
            try {
                const res = await fetch(`/api/orders/${id}`, { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    setOrder(data);
                } else {
                    const err = await res.json();
                    toast.error(err.message || 'Order not found');
                    navigate('/dashboard');
                }
            } catch (err) {
                toast.error('An unexpected error occurred');
                navigate('/dashboard');
            } finally {
                setLoading(false);
            }
        }
        load();
    }, [id, navigate, toast]);

    if (loading) return null;
    if (!order) return null;

    const STATUS_LABELS = { pending: 'Pending', accepted: 'Accepted', printing: 'Printing', ready: 'Ready', completed: 'Completed', rejected: 'Rejected', cancelled: 'Cancelled' };

    return (
        <div className="app-layout order-details-page">
            <LogoLink />
            <div className="order-details-card" style={{ maxWidth: '500px', width: '100%', background: 'white', borderRadius: '1rem', boxShadow: '0 4px 20px rgba(0,0,0,0.1)', color: '#333' }}>
                <div className="order-details-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                    <h2 style={{ margin: 0 }}>Order #{order.ticket_number || order.id}</h2>
                    <span className={`status-badge status-${order.status}`}>{STATUS_LABELS[order.status] || order.status}</span>
                </div>

                <div className="details-section">
                    <h3 style={{ fontSize: '1rem', borderBottom: '1px solid #eee', paddingBottom: '0.5rem', marginBottom: '1rem', color: '#666' }}>STUDENT</h3>
                    <div style={{ marginBottom: '1.5rem' }}>
                        <p style={{ margin: '0.25rem 0' }}><strong>Name:</strong> {order.full_name || 'N/A'}</p>
                        <p style={{ margin: '0.25rem 0' }}><strong>Phone:</strong> {order.phone_number || 'N/A'}</p>
                        <p style={{ margin: '0.25rem 0' }}><strong>Class/Room:</strong> {order.class_room_number || 'N/A'}</p>
                    </div>

                    <h3 style={{ fontSize: '1rem', borderBottom: '1px solid #eee', paddingBottom: '0.5rem', marginBottom: '1rem', color: '#666' }}>ORDER DETAILS</h3>
                    <div style={{ marginBottom: '1.5rem' }}>
                        <p style={{ margin: '0.25rem 0' }}><strong>Pages:</strong> {order.total_pages || 0}</p>
                        <p style={{ margin: '0.25rem 0' }}><strong>Copies:</strong> {order.copies || 1}</p>
                        <p style={{ margin: '0.25rem 0' }}><strong>Print:</strong> {order.color_option === 'bw' ? 'Black & White' : 'Colour'} / {order.printing_side === 'double' ? 'Double-sided' : 'Single-sided'}</p>
                        <p style={{ margin: '0.25rem 0' }}><strong>Printing Cost:</strong> ₹{parseFloat(order.total_price).toFixed(2)}</p>
                    </div>

                    <h3 style={{ fontSize: '1rem', borderBottom: '1px solid #eee', paddingBottom: '0.5rem', marginBottom: '1rem', color: '#666' }}>DELIVERY</h3>
                    <div style={{ marginBottom: '1.5rem' }}>
                        <p style={{ margin: '0.25rem 0' }}><strong>Location:</strong> {order.collection_location || 'N/A'}</p>
                        <p style={{ margin: '0.25rem 0' }}><strong>Time:</strong> {order.collection_time || 'N/A'}</p>
                    </div>

                    <div style={{ textAlign: 'right', marginTop: '2rem', paddingTop: '1rem', borderTop: '2px solid #eee' }}>
                        <p style={{ fontSize: '1.25rem', margin: 0 }}><strong>Total: ₹{parseFloat(order.total_price).toFixed(2)}</strong></p>
                        <p style={{ margin: '0.5rem 0 0 0', color: order.payment?.status === 'success' ? 'green' : 'red' }}>
                            Payment: {order.payment?.status === 'success' ? '✓ Paid' : 'Pending'}
                        </p>
                    </div>
                </div>
                <button onClick={() => navigate('/dashboard')} className="auth-submit" style={{ width: '100%', marginTop: '2rem' }}>
                    Back to Dashboard
                </button>
            </div>
            <Toast toast={toast} />
        </div>
    );
}
