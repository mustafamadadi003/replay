import "dotenv/config";
import { prisma } from "../lib/db/client";
import { generateReportShareSlug } from "../lib/reports/share";
import { reconcileFacebookComments } from "../lib/polling/facebook-comment-reconciler";

const DM_MESSAGE = `۱۰ اشتباه مهم در فرآیند استخدام

۱) عدم وقت‌شناسی — تأخیر بدون اطلاع قبلی
۲) ظاهر غیرحرفه‌ای — عدم رعایت پوشش و آراستگی مناسب
۳) ضعف در شنیدن — قطع صحبت مصاحبه‌کننده و درک نادرست سؤال‌ها
۴) بدگویی از کارفرمای قبلی — انتقاد غیرحرفه‌ای از مدیران و همکاران
۵) ارائه اطلاعات نادرست — اغراق یا دروغ درباره مهارت و تجربه
۶) عدم آمادگی — نداشتن شناخت کافی از سازمان و بست موردنظر
۷) رفتار غیرحرفه‌ای — بی‌توجهی، استفاده از موبایل و بی‌احترامی
۸) ضعف در معرفی توانمندی‌ها — ناتوانی در بیان مهارت‌ها و دستاوردها
۹) تمرکز صرف بر حقوق — نادیده گرفتن مسئولیت‌ها و اهداف شغلی
۱۰) عدم پذیرش مسئولیت — سرزنش دیگران و مقاومت در برابر انتقاد و یادگیری

از دیدگاه کارفرما

استخدام تنها پر کردن یک بست نیست، بلکه سرمایه‌گذاری روی آینده سازمان است. بنابراین، تخصص، صداقت، مسئولیت‌پذیری، توانایی یادگیری و رفتار حرفه‌ای باید هم‌زمان مورد ارزیابی قرار گیرد.`;

async function main() {
  const page = await prisma.facebookPage.findFirst({
    orderBy: { connectedAt: "desc" },
  });
  if (!page) throw new Error("No Facebook Page connected");

  const workspace = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (!workspace) throw new Error("No workspace");

  const existing = await prisma.automation.findFirst({
    where: { name: "لیست استخدام", facebookPageId: page.id },
  });
  if (existing) {
    console.log("Campaign already exists", existing.id);
  } else {
    const created = await prisma.automation.create({
      data: {
        workspaceId: workspace.id,
        facebookPageId: page.id,
        instagramAccountId: null,
        name: "لیست استخدام",
        postId: "882133628323864_122142603273169818",
        postUrl: "https://www.facebook.com/reel/1651260813039556/",
        matchAnyPost: false,
        pendingNextReel: false,
        keywords: ["لیست"],
        matchAnyWord: false,
        wholeWordMatch: false,
        dmTriggerEnabled: false,
        dmMessage: DM_MESSAGE,
        openingDmEnabled: false,
        requireFollow: false,
        followUpEnabled: false,
        publicReplyEnabled: false,
        isActive: true,
        reportShareSlug: generateReportShareSlug(),
        reportShareEnabled: true,
      },
    });
    console.log("Created campaign", created.id);
  }

  // Any orphan SENT logs from earlier webhook before cascade?
  const recentLogs = await prisma.dmLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      status: true,
      commentText: true,
      commentId: true,
      automationId: true,
      createdAt: true,
    },
  });
  console.log("RECENT_LOGS", recentLogs);

  console.log("Backfill…");
  await reconcileFacebookComments();
  console.log("DONE");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
