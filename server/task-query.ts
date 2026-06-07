/** Exclude auto_review rows from general task listings (reviews use /api/reviews). */
export const SQL_EXCLUDE_AUTO_REVIEW = `(t.source IS NULL OR t.source <> 'auto_review')`;
