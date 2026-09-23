import { Bot, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '../components/UI';
import { api } from '../services/api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const submit = async e => {
    e.preventDefault();
    if (!email || !password) return setError('Enter your email and password.');
    setLoading(true);
    setError('');
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      sessionStorage.setItem('customer_ai_token', data.token);
      sessionStorage.setItem('customer_ai_user', JSON.stringify(data.user));
      navigate('/dashboard');
    } catch (err) {
      setError(err.message || 'Sign-in failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-glow login-glow-a" />
      <div className="login-glow login-glow-b" />
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark"><Bot size={24} /></span>
          <b>Customer <i>AI</i></b>
        </div>
        <h1>Welcome back</h1>
        <p className="login-sub">Sign in to manage your customer conversations and your AI agent.</p>

        {error && <div className="notice-error">{error}</div>}

        <label className="field">
          <span>Email</span>
          <div className="input-with-icon">
            <Mail size={15} />
            <input className="input" value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="you@business.com" autoComplete="username" required />
          </div>
        </label>

        <label className="field">
          <span>Password</span>
          <div className="input-with-icon">
            <LockKeyhole size={15} />
            <input className="input" value={password} onChange={e => setPassword(e.target.value)} type={show ? 'text' : 'password'} placeholder="••••••••" autoComplete="current-password" required />
            <button type="button" className="password-toggle" onClick={() => setShow(s => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </label>

        <button className="button login-button" type="submit" disabled={loading}>
          {loading ? <Spinner size={16} /> : <LockKeyhole size={15} />}
          {loading ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="login-foot"><ShieldCheck size={13} /> Credentials are stored only in your browser session.</p>
      </form>
    </div>
  );
}