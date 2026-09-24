import styles from './Skeleton.module.css';

type SkeletonVariant = 'text' | 'circle' | 'rectangle';

interface SkeletonProps {
  variant?: SkeletonVariant;
  width?: number | string;
  height?: number | string;
  className?: string;
}

export function Skeleton({ variant = 'text', width, height, className }: SkeletonProps) {
  const classes = [styles.skeleton, styles[variant], className].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      style={{
        width: width,
        height: height,
      }}
      aria-hidden="true"
    />
  );
}
