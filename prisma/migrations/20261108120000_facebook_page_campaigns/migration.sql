-- Facebook Page model + optional Page FK on Automation + DmLog

CREATE TABLE IF NOT EXISTS "FacebookPage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "webhookSubscribed" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookPage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FacebookPage_pageId_key" ON "FacebookPage"("pageId");
CREATE INDEX IF NOT EXISTS "FacebookPage_workspaceId_idx" ON "FacebookPage"("workspaceId");

DO $$ BEGIN
  ALTER TABLE "FacebookPage"
    ADD CONSTRAINT "FacebookPage_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Automation" ALTER COLUMN "instagramAccountId" DROP NOT NULL;
ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "facebookPageId" TEXT;

ALTER TABLE "DmLog" ALTER COLUMN "instagramAccountId" DROP NOT NULL;
ALTER TABLE "DmLog" ADD COLUMN IF NOT EXISTS "facebookPageId" TEXT;

CREATE INDEX IF NOT EXISTS "Automation_facebookPageId_idx" ON "Automation"("facebookPageId");
CREATE INDEX IF NOT EXISTS "DmLog_facebookPageId_idx" ON "DmLog"("facebookPageId");

DO $$ BEGIN
  ALTER TABLE "Automation"
    ADD CONSTRAINT "Automation_facebookPageId_fkey"
    FOREIGN KEY ("facebookPageId") REFERENCES "FacebookPage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "DmLog"
    ADD CONSTRAINT "DmLog_facebookPageId_fkey"
    FOREIGN KEY ("facebookPageId") REFERENCES "FacebookPage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "LinkClick" ALTER COLUMN "instagramAccountId" DROP NOT NULL;
