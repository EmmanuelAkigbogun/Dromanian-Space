import { useState, createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import styles from './Tabs.module.css';

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (id: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

interface TabsProps {
  defaultTab: string;
  children: ReactNode;
  className?: string;
}

export function Tabs({ defaultTab, children, className }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab);

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div className={`${styles.tabs} ${className || ''}`}>{children}</div>
    </TabsContext.Provider>
  );
}

interface TabsListProps {
  children: ReactNode;
  className?: string;
}

export function TabsList({ children, className }: TabsListProps) {
  return <div className={`${styles.tabsList} ${className || ''}`} role="tablist">{children}</div>;
}

interface TabsTriggerProps {
  id: string;
  children: ReactNode;
  className?: string;
}

export function TabsTrigger({ id, children, className }: TabsTriggerProps) {
  const context = useContext(TabsContext);
  const ref = useRef<HTMLButtonElement>(null);
  if (!context) throw new Error('TabsTrigger must be used within Tabs');

  const { activeTab, setActiveTab } = context;
  const isActive = activeTab === id;

  useEffect(() => {
    if (isActive && ref.current) {
      ref.current.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }, [isActive]);

  return (
    <button
      ref={ref}
      className={`${styles.tab} ${isActive ? styles.tabActive : ''} ${className || ''}`}
      role="tab"
      aria-selected={isActive}
      aria-controls={`panel-${id}`}
      id={`tab-${id}`}
      onClick={() => setActiveTab(id)}
      type="button"
    >
      {children}
    </button>
  );
}

interface TabsContentProps {
  id: string;
  children: ReactNode;
  className?: string;
}

export function TabsContent({ id, children, className }: TabsContentProps) {
  const context = useContext(TabsContext);
  if (!context) throw new Error('TabsContent must be used within Tabs');

  const { activeTab } = context;
  const isActive = activeTab === id;

  return (
    <div
      className={`${styles.tabPanel} ${!isActive ? styles.tabPanelHidden : ''} ${className || ''}`}
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!isActive}
    >
      {children}
    </div>
  );
}
