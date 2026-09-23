import { ArrowRight, Bell, Inbox, RefreshCw, Search, X } from 'lucide-react';

export const Avatar = ({ name = '?', size = 'md', tone = 'auto', className = '' }) => {
  const initials = String(name || '?')
    .split(/\s+/)
    .map(n => n[0])
    .filter(Boolean)
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const pick = tone === 'auto'
    ? ['purple', 'orange', 'green', 'blue', 'pink'][(String(name).charCodeAt(0) || 0) % 5]
    : tone;
  return <span className={`avatar avatar-${size} avatar-${pick} ${className}`} aria-hidden="true">{initials}</span>;
};

export const Badge = ({ children, tone = 'neutral', className = '' }) => (
  <span className={`badge badge-${tone} ${className}`}>{children}</span>
);

export const StatusPill = ({ children, tone = 'neutral' }) => (
  <span className={`status-pill status-${tone}`}><i className="status-dot" />{children}</span>
);

export const PageHeading = ({ eyebrow, title, description, action, icon }) => (
  <div className="page-heading">
    <div className="page-heading-copy">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{icon && <span className="page-heading-icon">{icon}</span>}{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {action && <div className="page-heading-actions">{action}</div>}
  </div>
);

export const Button = ({ children, variant = '', size = '', className = '', icon, ...props }) => (
  <button className={`button ${variant ? `button-${variant}` : ''} ${size ? `button-${size}` : ''} ${className}`} {...props}>
    {icon}
    {children}
  </button>
);

export const IconButton = ({ label, children, ...props }) => (
  <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>
);

export const SearchBar = ({ value, onChange, placeholder = 'Search...', className = '' }) => (
  <label className={`searchbar ${className}`}>
    <Search size={16} />
    <input value={value || ''} onChange={onChange || (() => {})} placeholder={placeholder} />
    {value && (
      <button type="button" className="searchbar-clear" aria-label="Clear search" onClick={() => onChange?.({ target: { value: '' } })}>
        <X size={14} />
      </button>
    )}
  </label>
);

export const Spinner = ({ size = 18 }) => <span className={`spinner spinner-${size}`} aria-hidden="true" />;

export const Skeleton = ({ width = '100%', height = 14, className = '' }) => (
  <span className={`skeleton ${className}`} style={{ width, height }} aria-hidden="true" />
);

const EmptyIcon = ({ error }) => (
  <span className={`empty-state-icon ${error ? 'empty-state-icon-error' : ''}`} aria-hidden="true">
    {error ? <span className="error-mark">!</span> : <Inbox size={26} />}
  </span>
);

export const EmptyState = ({ icon, title, description, action, error = false }) => (
  <div className={`empty-state ${error ? 'empty-state-error' : ''}`}>
    {icon || <EmptyIcon error={error} />}
    <h3>{title}</h3>
    {description && <p>{description}</p>}
    {action}
  </div>
);

export const ErrorState = ({ title = 'Something went wrong', description, onRetry }) => (
  <EmptyState error icon title={title} description={description}
    action={onRetry ? <Button variant="outline" icon={<RefreshCw size={16} />} onClick={onRetry}>Try again</Button> : undefined} />
);

export const KpiCard = ({ label, value, hint, icon, tone = 'violet', loading }) => (
  <article className="kpi-card">
    <div className="kpi-card-top">
      <span className="kpi-label">{label}</span>
      <span className={`kpi-icon kpi-${tone}`}>{icon}</span>
    </div>
    {loading ? <Skeleton width={56} height={28} className="kpi-value-skeleton" /> : <strong className="kpi-value">{value}</strong>}
    {hint && <span className="kpi-hint">{hint}</span>}
  </article>
);

export const Panel = ({ title, description, action, children, className = '' }) => (
  <article className={`panel ${className}`}>
    {(title || action) && (
      <div className="panel-header">
        <div>
          {title && <h3>{title}</h3>}
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
    )}
    {children}
  </article>
);

export const PanelLink = ({ onClick, children }) => (
  <button type="button" className="panel-link" onClick={onClick}>{children}<ArrowRight size={14} /></button>
);

export const BellButton = ({ has, label = `${has ? 'New ' : ''}Notifications` }) => (
  <IconButton label={label}>{has && <span className="icon-button-dot" />}<Bell size={18} /></IconButton>
);