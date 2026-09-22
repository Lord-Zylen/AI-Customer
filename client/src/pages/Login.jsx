import { Bot, LockKeyhole } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../services/api';

const DEV_EMAIL = 'admin@customer-ai.test';
const DEV_PASSWORD = 'ChangeMe123!';

export default function Login() {
  const [email, setEmail] = useState(import.meta.env.DEV ? DEV_EMAIL : '');
  const [password, setPassword] = useState(import.meta.env.DEV ? DEV_PASSWORD : '');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const submit = async e => {
    e.preventDefault();
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      sessionStorage.setItem('customer_ai_token', data.token);
      sessionStorage.setItem('customer_ai_user', JSON.stringify(data.user));
      navigate('/inbox');
    } catch (e) {
      setError(e.message);
    }
  };
  return <main className="login-page">
    <form onSubmit={submit} className="login-card">
      <div className="login-brand"><span className="brand-mark"><Bot size={22}/></span><b>Customer AI</b></div>
      <h1>Welcome back</h1>
      <p>Sign in to manage your customer conversations.</p>
      {error && <div className="setup-error">{error}</div>}
      <label>Email<input value={email} onChange={e => setEmail(e.target.value)} type="email" required/></label>
      <label>Password<input value={password} onChange={e => setPassword(e.target.value)} type="password" required/></label>
      <button className="button login-button"><LockKeyhole size={16}/> Sign in</button>
      {import.meta.env.DEV && <small>Development build: demo credentials are prefilled after running the seed command.</small>}
    </form>
  </main>;
}