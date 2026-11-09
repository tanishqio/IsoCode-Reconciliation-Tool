import { PageHeader } from "../components/ui";

// Stand-in for a page that has not been built yet.
export function PlaceholderPage({ title }: { title: string }) {
  return <PageHeader title={title} description="This page has not been built yet." />;
}
