import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';

import Home from './pages/Home';
import About from './pages/About';
import NewOrder from './pages/NewOrder';
import SelectLocation from './pages/SelectLocation';
import Ticket from './pages/Ticket';
import OrderDetails from './pages/OrderDetails';
import Orders from './pages/Orders';

import AdminLogin from './pages/admin/Login';
import AdminLayout from './pages/admin/AdminLayout';
import AdminIndex from './pages/admin/Index';
import AdminOrders from './pages/admin/Orders';
import AdminEarnings from './pages/admin/Earnings';
import AdminTransactions from './pages/admin/Transactions';
import AdminShopProfile from './pages/admin/ShopProfile';
import AdminSettings from './pages/admin/Settings';

import SuperAdminLogin from './pages/super-admin/Login';
import SuperAdminLayout from './pages/super-admin/SuperAdminLayout';
import SuperAdminIndex from './pages/super-admin/Index';
import SuperAdminUsers from './pages/super-admin/Users';
import SuperAdminShops from './pages/super-admin/Shops';
import SuperAdminOrders from './pages/super-admin/Orders';
import SuperAdminPayments from './pages/super-admin/Payments';
import SuperAdminTransactions from './pages/super-admin/Transactions';
import SuperAdminPaymentGateway from './pages/super-admin/PaymentGateway';
import SuperAdminAnalytics from './pages/super-admin/Analytics';
import SuperAdminSettings from './pages/super-admin/Settings';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public Routes */}
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />

        {/* Student Guest Flow - Now Public */}
        <Route path="/new-order" element={<NewOrder />} />
        <Route path="/select-location" element={<SelectLocation />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/ticket" element={<Ticket />} />
        <Route path="/order/:id" element={<OrderDetails />} />

        {/* Shop Admin Routes */}
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminIndex />} />
          <Route path="orders" element={<AdminOrders />} />
          <Route path="earnings" element={<AdminEarnings />} />
          <Route path="transactions" element={<AdminTransactions />} />
          <Route path="shop-profile" element={<AdminShopProfile />} />
          <Route path="settings" element={<AdminSettings />} />
        </Route>

        {/* Super Admin Routes */}
        <Route path="/super-admin/login" element={<SuperAdminLogin />} />
        <Route path="/super-admin" element={<SuperAdminLayout />}>
          <Route index element={<SuperAdminIndex />} />
          <Route path="users" element={<SuperAdminUsers />} />
          <Route path="shops" element={<SuperAdminShops />} />
          <Route path="orders" element={<SuperAdminOrders />} />
          <Route path="payments" element={<SuperAdminPayments />} />
          <Route path="transactions" element={<SuperAdminTransactions />} />
          <Route path="payment-gateway" element={<SuperAdminPaymentGateway />} />
          <Route path="analytics" element={<SuperAdminAnalytics />} />
          <Route path="settings" element={<SuperAdminSettings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
