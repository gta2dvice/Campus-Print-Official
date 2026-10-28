import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import React, { Suspense, lazy } from 'react';

import Maintenance from './Maintenance';
import Home from './pages/Home';
import About from './pages/About';
import NewOrder from './pages/NewOrder';
import SelectLocation from './pages/SelectLocation';
import Ticket from './pages/Ticket';
import OrderDetails from './pages/OrderDetails';
import Orders from './pages/Orders';
import Signup from './pages/Signup';

// Shop Admin Routes
const AdminLogin = lazy(() => import('./pages/admin/Login'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const AdminIndex = lazy(() => import('./pages/admin/Index'));
const AdminOrders = lazy(() => import('./pages/admin/Orders'));
const AdminEarnings = lazy(() => import('./pages/admin/Earnings'));
const AdminTransactions = lazy(() => import('./pages/admin/Transactions'));
const AdminShopProfile = lazy(() => import('./pages/admin/ShopProfile'));
const AdminSettings = lazy(() => import('./pages/admin/Settings'));

// Super Admin Routes
const SuperAdminLogin = lazy(() => import('./pages/super-admin/Login'));
const SuperAdminLayout = lazy(() => import('./pages/super-admin/SuperAdminLayout'));
const SuperAdminIndex = lazy(() => import('./pages/super-admin/Index'));
const SuperAdminUsers = lazy(() => import('./pages/super-admin/Users'));
const SuperAdminShops = lazy(() => import('./pages/super-admin/Shops'));
const SuperAdminOrders = lazy(() => import('./pages/super-admin/Orders'));
const SuperAdminPayments = lazy(() => import('./pages/super-admin/Payments'));
const SuperAdminTransactions = lazy(() => import('./pages/super-admin/Transactions'));
const SuperAdminPaymentGateway = lazy(() => import('./pages/super-admin/PaymentGateway'));
const SuperAdminAnalytics = lazy(() => import('./pages/super-admin/Analytics'));
const SuperAdminSettings = lazy(() => import('./pages/super-admin/Settings'));

// Set to false (or set VITE_MAINTENANCE_MODE="false" in env) to reopen public routes
const IS_MAINTENANCE = import.meta.env.VITE_MAINTENANCE_MODE !== 'false';

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', fontSize: '1.2rem', fontFamily: 'inherit' }}>Loading...</div>}>
        <Routes>
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

          {/* When maintenance is active, all non-admin routes show the break page */}
          {IS_MAINTENANCE ? (
            <Route path="*" element={<Maintenance />} />
          ) : (
            <>
              {/* Public Routes */}
              <Route path="/" element={<Home />} />
              <Route path="/about" element={<About />} />

              {/* Student Guest Flow */}
              <Route path="/new-order" element={<NewOrder />} />
              <Route path="/select-location" element={<SelectLocation />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/signup" element={<Signup />} />
              <Route path="/ticket" element={<Ticket />} />
              <Route path="/order/:id" element={<OrderDetails />} />

              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
