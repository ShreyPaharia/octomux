import { useParams } from 'react-router-dom';

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="p-6 text-sm text-muted-foreground" data-testid="review-detail-page">
      Review detail for {id} (placeholder)
    </div>
  );
}
