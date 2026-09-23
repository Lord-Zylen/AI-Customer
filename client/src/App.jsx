import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './layouts/AppLayout';
import AiAgent from './pages/AiAgent';
import Analytics from './pages/Analytics';
import Conversations from './pages/Conversations';
import Customers from './pages/Customers';
import Dashboard from './pages/Dashboard';
import HumanQueue from './pages/HumanQueue';
import Login from './pages/Login';
import Orders from './pages/Orders';
import Settings from './pages/Settings';
import WhatsAppSetup from './pages/WhatsAppSetup';

const Protected = ({ children }) =>
  sessionStorage.getItem('customer_ai_token') ? children : <Navigate to="/login" replace />;

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected><AppLayout /></Protected>}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/conversations" element={<Conversations />} />
        <Route path="/conversations/:id" element={<Conversations />} />
        <Route path="/human-queue" element={<HumanQueue />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/ai-agent" element={<AiAgent />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/whatsapp" element={<WhatsAppSetup />} />
        <Route path="/settings" element={<Settings />} />

        <Route path="/inbox" element={<Navigate to="/conversations" replace />} />
        <Route path="/human-required" element={<Navigate to="/human-queue" replace />} />
        <Route path="/system-status" element={<Navigate to="/ai-agent" replace />} />
        <Route path="/whatsapp-setup" element={<Navigate to="/whatsapp" replace />} />
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}