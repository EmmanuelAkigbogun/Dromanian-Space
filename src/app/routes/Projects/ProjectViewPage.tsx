import { useParams } from 'react-router-dom';
import { ProjectDetail } from '@/components/projects/ProjectDetail';
import { GithubProjectBar } from '@/components/github/GithubProjects';
import styles from './ProjectViewPage.module.css';

export function ProjectViewPage() {
  const { projectId } = useParams<{ projectId: string }>();

  if (!projectId) return null;

  return (
    <div className={styles.page}>
      <GithubProjectBar projectId={projectId} />
      <ProjectDetail projectId={projectId} />
    </div>
  );
}
