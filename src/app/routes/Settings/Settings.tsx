import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWorkspace } from '@/hooks/useWorkspace';
import { canInviteMembers, canManageSettings } from '@/lib/workspace/permissions';
import { Button } from '@/components/ui/Button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { MembersList } from '@/components/workspace/members/MembersList';
import { InviteMemberDialog } from '@/components/workspace/members/InviteMemberDialog';
import { WorkspaceGeneralSettings } from '@/components/workspace/WorkspaceGeneralSettings';
import { WorkspaceDangerZone } from '@/components/workspace/WorkspaceDangerZone';
import { WorkspaceDataExport } from '@/components/workspace/WorkspaceDataExport';
import { WorkspaceDataImport } from '@/components/workspace/WorkspaceDataImport';
import { WorkspaceAuditLog } from '@/components/workspace/WorkspaceAuditLog';
import { WorkspacePreferences } from '@/components/workspace/WorkspacePreferences';
import { TypographySettings } from '@/components/workspace/TypographySettings';
import { ColorSettings } from '@/components/workspace/ColorSettings';
import styles from './Settings.module.css';

export function Settings() {
  const { currentWorkspace, currentRole } = useWorkspace();
  const [searchParams] = useSearchParams();
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const canInvite = canInviteMembers(currentRole);
  const canManage = canManageSettings(currentRole);

  const requestedTab = searchParams.get('tab') ?? 'general';
  const validTabs = [
    'general',
    'members',
    'typography',
    'colors',
    'preferences',
    'audit',
    'data',
    'import',
    'danger',
  ];
  const initialTab = validTabs.includes(requestedTab) ? requestedTab : 'general';

  if (!currentWorkspace) return null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Settings</h1>
          <p className={styles.description}>
            Manage <strong>{currentWorkspace.name}</strong>.
          </p>
        </div>
        {canInvite && (
          <Button onClick={() => setIsInviteOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 'var(--space-2)' }}>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Invite member
          </Button>
        )}
      </div>

      <Tabs defaultTab={initialTab} key={initialTab}>
        <TabsList>
          <TabsTrigger id="general">General</TabsTrigger>
          <TabsTrigger id="members">Members</TabsTrigger>
          <TabsTrigger id="typography">Typography</TabsTrigger>
          <TabsTrigger id="colors">Colors</TabsTrigger>
          {canManage && <TabsTrigger id="preferences">Preferences</TabsTrigger>}
          {canManage && <TabsTrigger id="audit">Audit Log</TabsTrigger>}
          <TabsTrigger id="data">Data Export</TabsTrigger>
          <TabsTrigger id="import">Import Data</TabsTrigger>
          <TabsTrigger id="danger">Danger Zone</TabsTrigger>
        </TabsList>

        <TabsContent id="general">
          <div className={styles.panel}>
            <WorkspaceGeneralSettings />
          </div>
        </TabsContent>

        <TabsContent id="members">
          <div className={styles.panel}>
            <MembersList />
          </div>
        </TabsContent>

        <TabsContent id="typography">
          <div className={styles.panel}>
            <TypographySettings />
          </div>
        </TabsContent>

        <TabsContent id="colors">
          <div className={styles.panel}>
            <ColorSettings />
          </div>
        </TabsContent>

        {canManage && (
          <TabsContent id="preferences">
            <div className={styles.panel}>
              <WorkspacePreferences />
            </div>
          </TabsContent>
        )}

        {canManage && (
          <TabsContent id="audit">
            <div className={styles.panel}>
              <WorkspaceAuditLog />
            </div>
          </TabsContent>
        )}

        <TabsContent id="data">
          <div className={styles.panel}>
            <WorkspaceDataExport />
          </div>
        </TabsContent>

        <TabsContent id="import">
          <div className={styles.panel}>
            <WorkspaceDataImport />
          </div>
        </TabsContent>

        <TabsContent id="danger">
          <div className={styles.panel}>
            <WorkspaceDangerZone />
          </div>
        </TabsContent>
      </Tabs>

      <InviteMemberDialog open={isInviteOpen} onClose={() => setIsInviteOpen(false)} />
    </div>
  );
}
