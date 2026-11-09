import { PageHeader } from "../../components/ui";
import { UploadHistory } from "./UploadHistory";
import { UploadPanel } from "./UploadPanel";

export function UploadsPage() {
  return (
    <>
      <PageHeader
        title="Uploads"
        description="Add the reports your partners send. A file with new column names waits for you to review and approve its mapping; after that, files with the same columns are read automatically."
      />
      <div className="flex flex-col gap-8">
        <UploadPanel />
        <UploadHistory />
      </div>
    </>
  );
}
