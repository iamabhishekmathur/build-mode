'use client';
import { useCallback, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { StagecraftRoot } from '@stagecraft/react';

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Server components hold the data: re-fetch them when the prototype state changes.
  const refresh = useCallback(() => router.refresh(), [router]);
  return <StagecraftRoot onDataChange={refresh}>{children}</StagecraftRoot>;
}
