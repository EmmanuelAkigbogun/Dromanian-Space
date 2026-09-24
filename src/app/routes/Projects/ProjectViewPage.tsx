import { useParams } from 'react-router-dom';
import { ProjectDetail } from '@/components/projects/ProjectDetail';
import styles from './ProjectViewPage.module.css';

export function ProjectViewPage() {
  const { projectId } = useParams<{ projectId: string }>();

  if (!projectId) return null;

  return (
    <div className={styles.page}>
      <ProjectDetail projectId={projectId} />
    </div>
  );
}
