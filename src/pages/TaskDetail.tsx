import { useParams } from 'react-router-dom';

export default function TaskDetail() {
  const { id } = useParams();
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Task {id}</h1>
      <p className="text-zinc-400 mt-2">Task detail — coming in Batch 4</p>
    </div>
  );
}
