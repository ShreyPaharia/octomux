import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { TaskSidebar } from './TaskSidebar';

export default function TaskDetailLayout() {
  return (
    <div className="flex h-full">
      <TaskSidebar />
      <div className="min-w-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Loading...
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}
