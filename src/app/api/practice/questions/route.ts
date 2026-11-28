import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { withUser } from "@/lib/api-handler";
import type { AuthenticatedContext } from "@/lib/api-handler";
import { internalError, validationError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:practice:questions');

const PAGE_SIZE = 20;

const querySchema = z.object({
    notebookId: z.string().min(1).optional(),
    tag: z.string().trim().min(1).max(100).optional(),
    difficulty: z.enum(['easy', 'medium', 'hard', 'harder']).optional(),
    // attempted/unattempted：是否作答过；correct/wrong：按「最后一次作答结果」筛选
    status: z.enum(['attempted', 'unattempted', 'correct', 'wrong']).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(PAGE_SIZE),
});

/** 列表卡片需要的字段 */
const PRACTICE_QUESTION_SELECT = {
    id: true,
    questionText: true,
    difficulty: true,
    source: true,
    generatedAt: true,
    createdAt: true,
    errorItem: {
        select: {
            id: true,
            shortId: true,
            seqNo: true,
            questionText: true,
            subject: { select: { id: true, name: true } },
        },
    },
    attempts: {
        select: { id: true, result: true, isCorrect: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
        take: 1,
    },
    _count: { select: { attempts: true } },
} satisfies Prisma.PracticeQuestionSelect;

type PracticeQuestionRow = Prisma.PracticeQuestionGetPayload<{ select: typeof PRACTICE_QUESTION_SELECT }>;

/**
 * 卡片与筛选共用的「最后一次作答结果」。
 *
 * 历史记录里 result 可能为 NULL、只保存了 isCorrect，因此统一归一到 correct / wrong，
 * 否则只比较 result 会漏掉这批老数据。
 */
const EFFECTIVE_LAST_RESULT = Prisma.sql`(
    SELECT COALESCE(NULLIF(r.result, ''), CASE WHEN r.isCorrect = 1 THEN 'correct' ELSE 'wrong' END)
    FROM "PracticeRecord" r
    WHERE r.practiceQuestionId = q.id
    ORDER BY r.createdAt DESC, r.id DESC
    LIMIT 1
)`;

/**
 * 「作对 / 作错」的取值：作错与卡片配色保持一致，同时包含「最后一次记录为未作答」，
 * 避免卡片显示黄色却无法用「作错」筛出来。
 */
const RESULT_FILTER_VALUES = {
    correct: ['correct'],
    wrong: ['wrong', 'not_attempted'],
} as const;

interface ResultFilterOptions {
    userId: string;
    result: 'correct' | 'wrong';
    difficulty?: string;
    notebookId?: string;
    tag?: string;
    page: number;
    pageSize: number;
}

/**
 * 按「最后一次作答结果」筛选时，直接用一段 SQL 取回当前页的 ID 与总数。
 *
 * 用 SQL 而不是 Prisma 的两个原因：
 * 1. Prisma 的关联过滤无法表达「关联记录中最新的一条」；
 * 2. 只有把过滤与分页都放进 SQL，才不会退化成「先取全部 ID、再拼 id IN (...)」，
 *    后者在数据量大时会撞上 SQLite 的参数数量上限。
 */
async function findPageByEffectiveResult(options: ResultFilterOptions): Promise<{ ids: string[]; total: number }> {
    const { userId, result, difficulty, notebookId, tag, page, pageSize } = options;

    const filters: Prisma.Sql[] = [Prisma.sql`q.userId = ${userId}`];
    if (difficulty) filters.push(Prisma.sql`q.difficulty = ${difficulty}`);
    if (notebookId || tag) {
        const itemFilters: Prisma.Sql[] = [Prisma.sql`ei.id = q.errorItemId`];
        if (notebookId) itemFilters.push(Prisma.sql`ei.subjectId = ${notebookId}`);
        if (tag) {
            itemFilters.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "_ErrorItemToKnowledgeTag" m
                JOIN "KnowledgeTag" k ON k.id = m.B
                WHERE m.A = ei.id AND k.name = ${tag}
            )`);
        }
        filters.push(Prisma.sql`EXISTS (SELECT 1 FROM "ErrorItem" ei WHERE ${Prisma.join(itemFilters, " AND ")})`);
    }
    filters.push(Prisma.sql`${EFFECTIVE_LAST_RESULT} IN (${Prisma.join([...RESULT_FILTER_VALUES[result]])})`);
    const whereSql = Prisma.join(filters, " AND ");

    const [rows, totals] = await Promise.all([
        prisma.$queryRaw<Array<{ id: string }>>`
            SELECT q.id
            FROM "PracticeQuestion" q
            WHERE ${whereSql}
            ORDER BY q.generatedAt DESC, q.id DESC
            LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
        `,
        prisma.$queryRaw<Array<{ count: number | bigint }>>`
            SELECT COUNT(*) AS count
            FROM "PracticeQuestion" q
            WHERE ${whereSql}
        `,
    ]);

    return { ids: rows.map((row) => row.id), total: Number(totals[0]?.count ?? 0) };
}

function toItems(questions: PracticeQuestionRow[]) {
    return questions.map(({ attempts, _count, ...question }) => ({
        ...question,
        attemptCount: _count.attempts,
        lastAttempt: attempts[0] ?? null,
    }));
}

/** GET /api/practice/questions：当前用户已生成的智能练习历史题，可按错题本、知识点、难度与作答状态筛选 */
export const GET = withUser(async (req: Request, { user }: AuthenticatedContext) => {
    try {
        const params = new URL(req.url).searchParams;
        const parsed = querySchema.safeParse(Object.fromEntries(params));
        if (!parsed.success) {
            return validationError("Invalid practice question filters", parsed.error.issues);
        }
        const { notebookId, tag, difficulty, status, page, pageSize } = parsed.data;

        // 「作对 / 作错」按最后一次作答结果判定，过滤与分页都交给 SQL
        if (status === 'correct' || status === 'wrong') {
            const { ids, total } = await findPageByEffectiveResult({
                userId: user.id,
                result: status,
                difficulty,
                notebookId,
                tag,
                page,
                pageSize,
            });
            // 当前页最多 50 条，这里的 IN 不会触及参数上限
            const rows = ids.length === 0 ? [] : await prisma.practiceQuestion.findMany({
                where: { id: { in: ids } },
                select: PRACTICE_QUESTION_SELECT,
            });
            const byId = new Map(rows.map((row) => [row.id, row]));
            const ordered = ids.flatMap((id) => {
                const row = byId.get(id);
                return row ? [row] : [];
            });

            return NextResponse.json({
                page,
                pageSize,
                total,
                hasMore: page * pageSize < total,
                items: toItems(ordered),
            });
        }

        const where = {
            userId: user.id,
            ...(difficulty ? { difficulty } : {}),
            ...(status === 'attempted' ? { attempts: { some: {} } } : {}),
            ...(status === 'unattempted' ? { attempts: { none: {} } } : {}),
            ...(notebookId || tag ? {
                errorItem: {
                    ...(notebookId ? { subjectId: notebookId } : {}),
                    ...(tag ? { tags: { some: { name: tag } } } : {}),
                },
            } : {}),
        };

        const [total, questions] = await Promise.all([
            prisma.practiceQuestion.count({ where }),
            prisma.practiceQuestion.findMany({
                where,
                orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
                skip: (page - 1) * pageSize,
                take: pageSize,
                select: PRACTICE_QUESTION_SELECT,
            }),
        ]);

        return NextResponse.json({
            page,
            pageSize,
            total,
            hasMore: page * pageSize < total,
            items: toItems(questions),
        });
    } catch (error) {
        logger.error({ error }, 'Error listing practice questions');
        return internalError("Failed to list practice questions", { error, scope: "api:practice:questions" });
    }
});
