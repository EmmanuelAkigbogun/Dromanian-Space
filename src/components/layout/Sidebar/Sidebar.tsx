import { useLocation, NavLink } from 'react-router-dom';
import { WorkspaceSwitcher } from '@/components/workspace';
import { ChannelSidebar } from '@/components/layout/ChannelSidebar';
import { DmSidebar } from '@/components/dm/DmSidebar';
import { UserMenu } from '@/components/layout/UserMenu';
import { useLayout } from '@/app/providers/LayoutProvider';
import { useIsTablet } from '@/hooks/useBreakpoint';
import styles from './Sidebar.module.css';

interface SidebarProps { primaryNavigation:Array<{to:string;icon:React.ReactNode;label:string}>; secondaryNavigation?:Array<{to:string;icon:React.ReactNode;label:string}> }
export function Sidebar({primaryNavigation,secondaryNavigation=[]}:SidebarProps){
  const {pathname,search}=useLocation();const {isExpanded,toggleSidebar}=useLayout();const tablet=useIsTablet();const collapsed=tablet||!isExpanded;
  const chat=/^\/(channels|dm|messages|threads|saved-pinned)/.test(pathname);
  const drive=/^\/(drive|files)/.test(pathname);const agents=/^\/(agents|ai)/.test(pathname);const crm=pathname.startsWith('/crm');
  const rail=primaryNavigation.filter(n=>!['/projects','/calendar','/channels'].includes(n.to));
  const nav=(to:string,label:string)=><NavLink key={to} className={({isActive})=>`${styles.contextLink} ${(to.includes('?')?pathname===to.split('?')[0]&&new URLSearchParams(search).get('view')===new URLSearchParams(to.split('?')[1]).get('view'):isActive)?styles.selected:''}`} to={to} end={to==='/'}>{label}</NavLink>;
  return <aside className={styles.shell} aria-label="Workspace navigation"><div className={styles.rail}><div className={styles.brand} title="Dromanian Space">❀</div><WorkspaceSwitcher collapsed/>{rail.map(n=><NavLink key={n.to} to={n.to} end={n.to==='/'} aria-label={n.label} title={n.label} className={({isActive})=>`${styles.railLink} ${isActive?styles.selected:''}`}>{n.icon}<span>{n.label}</span></NavLink>)}<div className={styles.railBottom}><NavLink to="/notifications" className={styles.railLink} title="Activity" aria-label="Activity">◉<span>Activity</span></NavLink><NavLink to="/settings" className={styles.railLink} title="Settings" aria-label="Settings">⚙<span>Settings</span></NavLink><UserMenu collapsed/></div></div>
    {!collapsed&&<div className={styles.context}><div className={styles.contextHeader}><strong>{chat?'Conversations':drive?'Drive':agents?'Agents':crm?'CRM':'Workspace'}</strong><button aria-label="Collapse sidebar" className={styles.collapse} onClick={toggleSidebar}>‹</button></div><div className={styles.contextBody}>{chat?<>{nav('/threads','Followed threads')}{nav('/notifications','Mentions & activity')}{nav('/saved-pinned','Saved & pinned')}<ChannelSidebar/><DmSidebar isCollapsed={false}/></>:drive?<>{[['workspace','Workspace files'],['my','My files'],['shared','Shared with me'],['recent','Recent'],['starred','Starred'],['trash','Trash']].map(([v,label])=>nav(`/drive?view=${v}`,label))}</>:agents?<>{nav('/agents','Agent directory')}<p className={styles.contextHint}>Open an agent to start a private conversation, select knowledge sources, and review actions.</p></>:crm?<>{nav('/crm/contacts','Contacts')}{nav('/crm/companies','Companies')}{nav('/crm/deals','Deals')}</>:<>{nav('/','Overview')}{nav('/tasks','Tasks')}{nav('/projects','Projects')}{nav('/calendar','Calendar')}{nav('/channels','Browse channels')}</>}<details className={styles.more}><summary>More tools</summary>{secondaryNavigation.map(n=>nav(n.to,n.label))}{nav('/projects','Projects')}{nav('/calendar','Calendar')}</details></div></div>}
    {collapsed&&!tablet&&<button className={styles.expand} onClick={toggleSidebar} aria-label="Expand context sidebar">›</button>}
  </aside>;
}
