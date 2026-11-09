import { PageHeader } from "../../components/ui";
import { UploadHistory } from "./UploadHistory";
import { UploadPanel } from "./UploadPanel";

export function UploadsPage() {
  return (
    <>
      <PageHeader
        title="Uploads"
        description="Add the reports your partners send. Each file is checked and saved; mapping its columns is the next step."
      />
      <div className="flex flex-col gap-8">
        <UploadPanel />
        <UploadHistory />
      </div>
    </>
  );
}
