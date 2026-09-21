import { ArrowUpRight, ChevronDown, MoreHorizontal, Search } from 'lucide-react';
export const Badge=({children,tone='neutral'})=><span className={`badge ${tone}`}>{children}</span>;
export const PageHeading=({eyebrow,title,description,action})=><div className="page-heading"><div>{eyebrow&&<p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description&&<p>{description}</p>}</div>{action}</div>;
export const Button=({children,variant='',...props})=><button className={`button ${variant}`} {...props}>{children}</button>;
export const SearchBar=({placeholder='Search...'})=><label className="searchbar"><Search size={17}/><input placeholder={placeholder}/></label>;
export const Metric=({label,value,delta,icon,soft})=><article className="metric"><div className="metric-top"><span>{label}</span><div className={`metric-icon ${soft||''}`}>{icon}</div></div><strong>{value}</strong>{delta&&<p className={delta.startsWith('+')?'positive':''}>{delta} <small>vs last month</small></p>}</article>;
export const MiniMenu=()=> <button className="more"><MoreHorizontal size={19}/></button>;
export const Select=({children})=><button className="select">{children}<ChevronDown size={15}/></button>;
export const Trend=()=> <span className="trend"><ArrowUpRight size={13}/> 12.5%</span>;
