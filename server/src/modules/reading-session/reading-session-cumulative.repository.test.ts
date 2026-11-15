import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { bookFiles, readingSessionSyncCursors, readingSessions, userReadingDailyStats } from '../../db/schema';
import { ReadingSessionRepository, type RecordCumulativeReadingSessionParams } from './reading-session.repository';

function makeLimitChain(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  return { where, limit };
}

function makeHarness(
  options: {
    cursor?: { counter: number; generation: number; lastModified: Date } | null;
    measuredSeconds?: number;
    file?: { bookId: number; libraryId: number } | null;
    inserted?: boolean;
  } = {},
) {
  const cursorChain = makeLimitChain(options.cursor ? [options.cursor] : []);
  const measuredWhere = vi.fn().mockResolvedValue([{ seconds: options.measuredSeconds ?? 0 }]);
  const fileChain = makeLimitChain(options.file === null ? [] : [options.file ?? { bookId: 46, libraryId: 9 }]);

  const select = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation((table: unknown) => {
      if (table === readingSessionSyncCursors) return { where: cursorChain.where };
      if (table === readingSessions) return { where: measuredWhere };
      if (table === bookFiles) return { innerJoin: vi.fn().mockReturnValue({ where: fileChain.where }) };
      throw new Error('Unexpected table in select');
    }),
  }));

  const cursorInsertValues = vi.fn().mockResolvedValue(undefined);
  const sessionReturning = vi.fn().mockResolvedValue(options.inserted === false ? [] : [{ id: 101 }]);
  const sessionConflict = vi.fn().mockReturnValue({ returning: sessionReturning });
  const sessionValues = vi.fn().mockReturnValue({ onConflictDoNothing: sessionConflict });
  const dailyValues = vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table === readingSessionSyncCursors) return { values: cursorInsertValues };
    if (table === readingSessions) return { values: sessionValues };
    if (table === userReadingDailyStats) return { values: dailyValues };
    throw new Error('Unexpected table in insert');
  });

  const cursorUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const cursorUpdateSet = vi.fn().mockReturnValue({ where: cursorUpdateWhere });
  const update = vi.fn().mockReturnValue({ set: cursorUpdateSet });
  const tx = { execute: vi.fn().mockResolvedValue(undefined), select, insert, update };
  const transaction = vi.fn(async (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));
  const repo = new ReadingSessionRepository({ transaction } as never);

  return { repo, tx, transaction, cursorInsertValues, cursorUpdateSet, sessionValues, dailyValues, measuredWhere };
}

function boundParams(where: ReturnType<typeof vi.fn>): unknown[] {
  return new PgDialect().sqlToQuery(where.mock.calls[0]![0] as SQL).params;
}

const params = (overrides: Partial<RecordCumulativeReadingSessionParams> = {}): RecordCumulativeReadingSessionParams => ({
  userId: 7,
  bookId: 46,
  bookFileId: 53,
  cursorSource: 'kobo-statistics',
  sourceDeviceKey: '30',
  sessionIdPrefix: 'kst:30:',
  buildSessionId: (bookFileId, generation, counter) => `kst:30:${bookFileId}:${generation}:${counter}`,
  counter: 860,
  endedAt: new Date('2026-08-20T19:30:00.000Z'),
  progressDelta: 7,
  endProgress: 29,
  source: 'kobo',
  timeZone: 'Europe/Oslo',
  ...overrides,
});

describe('ReadingSessionRepository.recordCumulativeSyncedSession', () => {
  it('establishes an independent device baseline without creating a session', async () => {
    const { repo, cursorInsertValues, sessionValues } = makeHarness();

    await expect(repo.recordCumulativeSyncedSession(params())).resolves.toEqual({ kind: 'baseline' });

    expect(cursorInsertValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, bookId: 46, sourceDeviceKey: '30', counter: 860 }));
    expect(sessionValues).not.toHaveBeenCalled();
  });

  it('atomically stores the device delta and advances its cursor', async () => {
    const { repo, transaction, cursorUpdateSet, sessionValues, dailyValues } = makeHarness({
      cursor: { counter: 800, generation: 2, lastModified: new Date('2026-08-19T10:00:00.000Z') },
    });

    await expect(repo.recordCumulativeSyncedSession(params())).resolves.toEqual({
      kind: 'saved',
      durationSeconds: 3600,
      progressDelta: 7,
      sessionId: 'kst:30:53:2:860',
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(sessionValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        bookId: 46,
        bookFileId: 53,
        sourceDeviceKey: '30',
        sessionId: 'kst:30:53:2:860',
        durationSeconds: 3600,
        syncIntervalStartedAt: new Date('2026-08-19T10:00:00.000Z'),
      }),
    );
    expect(cursorUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ counter: 860, generation: 2 }));
    expect(dailyValues).toHaveBeenCalledOnce();
  });

  it('does not advance the cursor when the file is temporarily unavailable', async () => {
    const { repo, cursorUpdateSet, sessionValues } = makeHarness({
      cursor: { counter: 800, generation: 0, lastModified: new Date('2026-08-19T10:00:00.000Z') },
    });

    await expect(repo.recordCumulativeSyncedSession(params({ bookFileId: null }))).resolves.toEqual({
      kind: 'skipped',
      reason: 'book_file_not_found',
    });

    expect(cursorUpdateSet).not.toHaveBeenCalled();
    expect(sessionValues).not.toHaveBeenCalled();
  });

  it('advances without an estimate when measured analytics already cover the counter delta', async () => {
    const { repo, cursorUpdateSet, sessionValues } = makeHarness({
      cursor: { counter: 800, generation: 0, lastModified: new Date('2026-08-19T10:00:00.000Z') },
      measuredSeconds: 3590,
    });

    await expect(repo.recordCumulativeSyncedSession(params())).resolves.toEqual({
      kind: 'skipped',
      reason: 'measured_session_present',
    });

    expect(cursorUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ counter: 860 }));
    expect(sessionValues).not.toHaveBeenCalled();
  });

  it('keeps the part of the counter delta the device did not measure', async () => {
    const { repo, sessionValues, dailyValues } = makeHarness({
      cursor: { counter: 800, generation: 0, lastModified: new Date('2026-08-19T10:00:00.000Z') },
      measuredSeconds: 1500,
    });

    await expect(repo.recordCumulativeSyncedSession(params())).resolves.toEqual({
      kind: 'saved',
      durationSeconds: 2100,
      progressDelta: 4.08,
      sessionId: 'kst:30:53:0:860',
    });

    expect(sessionValues).toHaveBeenCalledWith(
      expect.objectContaining({
        startedAt: new Date('2026-08-20T18:55:00.000Z'),
        endedAt: new Date('2026-08-20T19:30:00.000Z'),
        durationSeconds: 2100,
        progressDelta: 4.08,
      }),
    );
    expect(dailyValues).toHaveBeenCalledWith([expect.objectContaining({ readingSeconds: 2100, progressDelta: 4.08 })]);
  });

  it('measures against the whole counter interval rather than the minutes before the push', async () => {
    const { repo, measuredWhere } = makeHarness({
      cursor: { counter: 800, generation: 0, lastModified: new Date('2026-08-19T10:00:00.000Z') },
    });

    await repo.recordCumulativeSyncedSession(params());

    expect(boundParams(measuredWhere)).toEqual(expect.arrayContaining(['2026-08-19T10:00:00.000Z', '2026-08-20T19:30:00.000Z']));
    expect(boundParams(measuredWhere)).not.toContain('2026-08-20T18:30:00.000Z');
  });

  it('starts a new generation when a newer device counter resets', async () => {
    const { repo, cursorUpdateSet, sessionValues } = makeHarness({
      cursor: { counter: 860, generation: 4, lastModified: new Date('2026-08-19T10:00:00.000Z') },
    });

    await expect(repo.recordCumulativeSyncedSession(params({ counter: 0 }))).resolves.toEqual({ kind: 'reset' });

    expect(cursorUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ counter: 0, generation: 5 }));
    expect(sessionValues).not.toHaveBeenCalled();
  });

  it('does not let an out-of-order push rewind a device cursor', async () => {
    const { repo, cursorUpdateSet } = makeHarness({
      cursor: { counter: 860, generation: 1, lastModified: new Date('2026-08-21T10:00:00.000Z') },
    });

    await expect(repo.recordCumulativeSyncedSession(params({ counter: 900 }))).resolves.toEqual({ kind: 'stale' });
    expect(cursorUpdateSet).not.toHaveBeenCalled();
  });

  it('advances the cursor after an idempotent duplicate', async () => {
    const { repo, cursorUpdateSet } = makeHarness({
      cursor: { counter: 800, generation: 0, lastModified: new Date('2026-08-19T10:00:00.000Z') },
      inserted: false,
    });

    await expect(repo.recordCumulativeSyncedSession(params())).resolves.toEqual({
      kind: 'skipped',
      reason: 'duplicate_session_id',
    });
    expect(cursorUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ counter: 860 }));
  });
});

describe('ReadingSessionRepository.recordCumulativeSyncedSession from a known counter origin', () => {
  const deliveredAt = new Date('2026-11-14T22:57:00.000Z');
  const pushedAt = new Date('2026-11-14T23:31:00.000Z');
  const firstPush = (overrides: Partial<RecordCumulativeReadingSessionParams> = {}) =>
    params({ counter: 33, endedAt: pushedAt, counterOriginAt: deliveredAt, progressDelta: null, ...overrides });

  it('records the first counter after delivery as a session and baselines the cursor with it', async () => {
    const { repo, cursorInsertValues, cursorUpdateSet, sessionValues, dailyValues } = makeHarness();

    await expect(repo.recordCumulativeSyncedSession(firstPush())).resolves.toEqual({
      kind: 'saved',
      durationSeconds: 1980,
      progressDelta: null,
      sessionId: 'kst:30:53:0:33',
    });

    expect(sessionValues).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'kst:30:53:0:33',
        sourceDeviceKey: '30',
        startedAt: new Date('2026-11-14T22:58:00.000Z'),
        endedAt: pushedAt,
        durationSeconds: 1980,
        syncIntervalStartedAt: deliveredAt,
      }),
    );
    expect(cursorInsertValues).toHaveBeenCalledWith(expect.objectContaining({ counter: 33, generation: 0, lastModified: pushedAt }));
    expect(cursorUpdateSet).not.toHaveBeenCalled();
    expect(dailyValues).toHaveBeenCalledOnce();
  });

  it('holds the session to the time since the counter origin', async () => {
    const { repo, sessionValues } = makeHarness();

    await expect(repo.recordCumulativeSyncedSession(firstPush({ counter: 90 }))).resolves.toMatchObject({ kind: 'saved', durationSeconds: 2040 });

    expect(sessionValues).toHaveBeenCalledWith(expect.objectContaining({ startedAt: deliveredAt, durationSeconds: 2040 }));
  });

  it('takes measured sessions off the first counter and measures them from the origin', async () => {
    const { repo, sessionValues, measuredWhere } = makeHarness({ measuredSeconds: 600 });

    await expect(repo.recordCumulativeSyncedSession(firstPush())).resolves.toMatchObject({ kind: 'saved', durationSeconds: 1380 });

    expect(sessionValues).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 1380 }));
    expect(boundParams(measuredWhere)).toEqual(expect.arrayContaining([deliveredAt.toISOString(), pushedAt.toISOString(), 'kobo', '30', 'kst:30:%']));
  });

  it('skips the first counter when measured sessions already cover it, still establishing the cursor', async () => {
    const { repo, cursorInsertValues, sessionValues } = makeHarness({ measuredSeconds: 1950 });

    await expect(repo.recordCumulativeSyncedSession(firstPush())).resolves.toEqual({ kind: 'skipped', reason: 'measured_session_present' });

    expect(cursorInsertValues).toHaveBeenCalledWith(expect.objectContaining({ counter: 33 }));
    expect(sessionValues).not.toHaveBeenCalled();
  });

  it('does not count the minutes of a counter pushed less than a tick after delivery', async () => {
    const { repo, cursorInsertValues, sessionValues } = makeHarness();

    await expect(repo.recordCumulativeSyncedSession(firstPush({ counter: 0 }))).resolves.toEqual({ kind: 'baseline' });
    expect(cursorInsertValues).toHaveBeenCalledWith(expect.objectContaining({ counter: 0 }));
    expect(sessionValues).not.toHaveBeenCalled();
  });

  it('keeps the baseline when there is no origin', async () => {
    for (const counterOriginAt of [undefined, null]) {
      const { repo, cursorInsertValues, sessionValues } = makeHarness();

      await expect(repo.recordCumulativeSyncedSession(firstPush({ counterOriginAt }))).resolves.toEqual({ kind: 'baseline' });

      expect(cursorInsertValues).toHaveBeenCalledWith(expect.objectContaining({ counter: 33, generation: 0 }));
      expect(sessionValues).not.toHaveBeenCalled();
    }
  });

  it('keeps the baseline when the origin is not before the push', async () => {
    const { repo, sessionValues } = makeHarness();

    await expect(repo.recordCumulativeSyncedSession(firstPush({ counterOriginAt: pushedAt }))).resolves.toEqual({ kind: 'baseline' });
    expect(sessionValues).not.toHaveBeenCalled();
  });

  it('leaves the cursor unwritten while the file cannot be resolved, so the first counter is retried', async () => {
    const { repo, cursorInsertValues, sessionValues } = makeHarness();

    await expect(repo.recordCumulativeSyncedSession(firstPush({ bookFileId: null }))).resolves.toEqual({
      kind: 'skipped',
      reason: 'book_file_not_found',
    });

    expect(cursorInsertValues).not.toHaveBeenCalled();
    expect(sessionValues).not.toHaveBeenCalled();
  });

  it('still establishes the cursor when the first session is a duplicate id', async () => {
    const { repo, cursorInsertValues, dailyValues } = makeHarness({ inserted: false });

    await expect(repo.recordCumulativeSyncedSession(firstPush())).resolves.toEqual({ kind: 'skipped', reason: 'duplicate_session_id' });

    expect(cursorInsertValues).toHaveBeenCalledWith(expect.objectContaining({ counter: 33 }));
    expect(dailyValues).not.toHaveBeenCalled();
  });

  it('counts only the new minutes on the push after the first, and nothing on a replay', async () => {
    const afterFirst = { counter: 33, generation: 0, lastModified: pushedAt };
    const next = new Date('2026-11-14T23:39:00.000Z');

    const second = makeHarness({ cursor: afterFirst });
    await expect(second.repo.recordCumulativeSyncedSession(firstPush({ counter: 34, endedAt: next }))).resolves.toMatchObject({
      kind: 'saved',
      durationSeconds: 60,
      sessionId: 'kst:30:53:0:34',
    });
    expect(second.sessionValues).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 60, syncIntervalStartedAt: pushedAt }));

    const replay = makeHarness({ cursor: afterFirst });
    await expect(replay.repo.recordCumulativeSyncedSession(firstPush())).resolves.toEqual({ kind: 'unchanged' });
    expect(replay.sessionValues).not.toHaveBeenCalled();
  });

  it('does not use the origin once the counter has a cursor to take a delta against', async () => {
    const { repo, sessionValues } = makeHarness({ cursor: { counter: 20, generation: 1, lastModified: new Date('2026-11-14T23:00:00.000Z') } });

    await expect(repo.recordCumulativeSyncedSession(firstPush({ counterOriginAt: new Date('2026-11-14T22:00:00.000Z') }))).resolves.toMatchObject({
      kind: 'saved',
      durationSeconds: 780,
    });
    expect(sessionValues).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'kst:30:53:1:33', syncIntervalStartedAt: new Date('2026-11-14T23:00:00.000Z') }),
    );
  });

  describe('when the counter went down', () => {
    const lastPush = new Date('2026-11-14T20:00:00.000Z');
    const redelivered = new Date('2026-11-14T22:57:00.000Z');
    const cursor = { counter: 240, generation: 2, lastModified: lastPush };

    it('records the new counter as a session in the next generation after a re-delivery since the last push', async () => {
      const { repo, cursorUpdateSet, sessionValues } = makeHarness({ cursor });

      await expect(repo.recordCumulativeSyncedSession(firstPush({ counterOriginAt: redelivered }))).resolves.toEqual({
        kind: 'saved',
        durationSeconds: 1980,
        progressDelta: null,
        sessionId: 'kst:30:53:3:33',
      });

      expect(sessionValues).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 1980, syncIntervalStartedAt: redelivered }));
      expect(cursorUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ counter: 33, generation: 3, lastModified: pushedAt }));
    });

    it('holds the session to the time since the re-delivery', async () => {
      const { repo, sessionValues } = makeHarness({ cursor });

      await expect(repo.recordCumulativeSyncedSession(firstPush({ counter: 200, counterOriginAt: redelivered }))).resolves.toMatchObject({
        kind: 'saved',
        durationSeconds: 2040,
      });
      expect(sessionValues).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 2040 }));
    });

    it('moves to the next generation without a session when the book was not re-delivered since the last push', async () => {
      const { repo, cursorUpdateSet, sessionValues } = makeHarness({ cursor });

      await expect(repo.recordCumulativeSyncedSession(firstPush({ counterOriginAt: new Date('2026-11-13T09:00:00.000Z') }))).resolves.toEqual({
        kind: 'reset',
      });

      expect(cursorUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ counter: 33, generation: 3 }));
      expect(sessionValues).not.toHaveBeenCalled();
    });

    it('moves to the next generation without a session when there is no origin', async () => {
      const { repo, cursorUpdateSet, sessionValues } = makeHarness({ cursor });

      await expect(repo.recordCumulativeSyncedSession(firstPush({ counterOriginAt: null }))).resolves.toEqual({ kind: 'reset' });

      expect(cursorUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ generation: 3 }));
      expect(sessionValues).not.toHaveBeenCalled();
    });

    it('reports a reset when the re-delivered counter has not yet reached a tick', async () => {
      const { repo, cursorUpdateSet, sessionValues } = makeHarness({ cursor });

      await expect(repo.recordCumulativeSyncedSession(firstPush({ counter: 0, counterOriginAt: redelivered }))).resolves.toEqual({ kind: 'reset' });

      expect(cursorUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ counter: 0, generation: 3 }));
      expect(sessionValues).not.toHaveBeenCalled();
    });
  });
});

describe('ReadingSessionRepository measured-session reconciliation', () => {
  type EstimateRow = { id: number; startedAt: Date; endedAt: Date; durationSeconds: number; progressDelta: number | null };
  type IntervalEstimateRow = EstimateRow & { syncIntervalStartedAt: Date };
  type SurvivingRow = Omit<EstimateRow, 'id'>;

  const estimateLookup = (rows: EstimateRow[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) }),
    }),
  });
  const intervalLookup = (rows: IntervalEstimateRow[]) => ({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockResolvedValue(rows) }) }),
  });
  const survivingLookup = (rows: SurvivingRow[]) => ({
    from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }) }),
  });
  const existingLookup = (rows: { id: number; durationSeconds: number; progressDelta: number | null }[]) => ({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) }),
  });

  const measured = {
    startedAt: new Date('2026-08-20T19:20:00.000Z'),
    endedAt: new Date('2026-08-20T19:30:00.000Z'),
    durationSeconds: 600,
    progressDelta: 2,
  };

  function makeMeasuredHarness(selects: unknown[], options: { inserted?: boolean } = {}) {
    const outerLimit = vi.fn().mockResolvedValue([{ bookId: 46, libraryId: 9 }]);
    const outerSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: outerLimit }) }) }),
    });
    const txSelect = vi.fn();
    for (const select of selects) txSelect.mockReturnValueOnce(select);

    const sessionValues = vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(options.inserted === false ? [] : [{ id: 21 }]) }),
    });
    const dailyValues = vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
    const insert = vi.fn().mockImplementation((table: unknown) => {
      if (table === readingSessions) return { values: sessionValues };
      if (table === userReadingDailyStats) return { values: dailyValues };
      throw new Error('Unexpected table in insert');
    });
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const deleteFn = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const tx = { execute: vi.fn().mockResolvedValue(undefined), insert, update, select: txSelect, delete: deleteFn };
    const transaction = vi.fn(async (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));
    const repo = new ReadingSessionRepository({ select: outerSelect, transaction } as never);

    const saveMeasured = () =>
      repo.saveSession(7, 53, 'measured-event', measured.startedAt, measured.endedAt, measured.durationSeconds, 2, 29, 'kobo', 'UTC', {
        sourceDeviceKey: '30',
        estimateSessionIdPrefix: 'kst:30:',
      });

    return { saveMeasured, transaction, txSelect, sessionValues, dailyValues, updateSet, deleteFn };
  }

  it('stores the device key and removes an overlapping estimate that predates interval tracking', async () => {
    const legacyEstimate = {
      id: 20,
      startedAt: new Date('2026-08-20T18:30:00.000Z'),
      endedAt: new Date('2026-08-20T19:30:00.000Z'),
      durationSeconds: 3600,
      progressDelta: 7,
    };
    const { saveMeasured, transaction, sessionValues, dailyValues, updateSet, deleteFn } = makeMeasuredHarness([
      estimateLookup([legacyEstimate]),
      intervalLookup([]),
      survivingLookup([measured]),
    ]);

    await expect(saveMeasured()).resolves.toEqual({ kind: 'saved' });

    expect(transaction).toHaveBeenCalledOnce();
    expect(sessionValues).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'measured-event', sourceDeviceKey: '30' }));
    expect(deleteFn).toHaveBeenCalledWith(readingSessions);
    expect(updateSet).not.toHaveBeenCalled();
    expect(dailyValues).toHaveBeenLastCalledWith([
      expect.objectContaining({ day: '2026-08-20', readingSeconds: 600, progressDelta: 2, sessionsCount: 1 }),
    ]);
  });

  it('removes the estimate of a later push once the measured session covers its counter interval', async () => {
    const lateEstimate = {
      id: 20,
      startedAt: new Date('2026-08-21T06:50:00.000Z'),
      endedAt: new Date('2026-08-21T07:00:00.000Z'),
      durationSeconds: 600,
      progressDelta: 2,
      syncIntervalStartedAt: new Date('2026-08-20T07:00:00.000Z'),
    };
    const { saveMeasured, dailyValues, updateSet, deleteFn } = makeMeasuredHarness([
      estimateLookup([]),
      intervalLookup([lateEstimate]),
      survivingLookup([measured]),
    ]);

    await expect(saveMeasured()).resolves.toEqual({ kind: 'saved' });

    expect(deleteFn).toHaveBeenCalledWith(readingSessions);
    expect(deleteFn).toHaveBeenCalledWith(userReadingDailyStats);
    expect(updateSet).not.toHaveBeenCalled();
    expect(dailyValues).toHaveBeenLastCalledWith([
      expect.objectContaining({ day: '2026-08-20', readingSeconds: 600, progressDelta: 2, sessionsCount: 1 }),
    ]);
  });

  it('shortens an estimate the measured session covers only in part', async () => {
    const lateEstimate = {
      id: 20,
      startedAt: new Date('2026-08-21T06:00:00.000Z'),
      endedAt: new Date('2026-08-21T07:00:00.000Z'),
      durationSeconds: 3600,
      progressDelta: 6,
      syncIntervalStartedAt: new Date('2026-08-20T07:00:00.000Z'),
    };
    const shortened = {
      startedAt: new Date('2026-08-21T06:10:00.000Z'),
      endedAt: new Date('2026-08-21T07:00:00.000Z'),
      durationSeconds: 3000,
      progressDelta: 5,
    };
    const { saveMeasured, dailyValues, updateSet, deleteFn } = makeMeasuredHarness([
      estimateLookup([]),
      intervalLookup([lateEstimate]),
      survivingLookup([measured, shortened]),
    ]);

    await expect(saveMeasured()).resolves.toEqual({ kind: 'saved' });

    expect(updateSet).toHaveBeenCalledWith({ startedAt: shortened.startedAt, durationSeconds: 3000, progressDelta: 5 });
    expect(deleteFn).not.toHaveBeenCalledWith(readingSessions);
    expect(dailyValues).toHaveBeenLastCalledWith([
      expect.objectContaining({ day: '2026-08-21', readingSeconds: 3000, progressDelta: 5, sessionsCount: 1 }),
    ]);
  });

  it('splits a measured session across the estimates whose counter intervals it overlaps', async () => {
    const pushedMidSession = new Date('2026-08-20T19:25:00.000Z');
    const before = {
      id: 20,
      startedAt: new Date('2026-08-20T19:05:00.000Z'),
      endedAt: pushedMidSession,
      durationSeconds: 1200,
      progressDelta: null,
      syncIntervalStartedAt: new Date('2026-08-20T07:00:00.000Z'),
    };
    const after = {
      id: 22,
      startedAt: new Date('2026-08-21T06:40:00.000Z'),
      endedAt: new Date('2026-08-21T07:00:00.000Z'),
      durationSeconds: 1200,
      progressDelta: null,
      syncIntervalStartedAt: pushedMidSession,
    };
    const { saveMeasured, updateSet, deleteFn } = makeMeasuredHarness([
      estimateLookup([]),
      intervalLookup([before, after]),
      survivingLookup([measured]),
    ]);

    await expect(saveMeasured()).resolves.toEqual({ kind: 'saved' });

    expect(updateSet).toHaveBeenCalledTimes(2);
    expect(updateSet).toHaveBeenNthCalledWith(1, { startedAt: new Date('2026-08-20T19:10:00.000Z'), durationSeconds: 900, progressDelta: null });
    expect(updateSet).toHaveBeenNthCalledWith(2, { startedAt: new Date('2026-08-21T06:45:00.000Z'), durationSeconds: 900, progressDelta: null });
    expect(deleteFn).not.toHaveBeenCalledWith(readingSessions);
  });

  it('takes nothing off an estimate when the measured session is a replay', async () => {
    const { saveMeasured, txSelect, updateSet, deleteFn } = makeMeasuredHarness(
      [existingLookup([{ id: 21, durationSeconds: 600, progressDelta: 2 }]), estimateLookup([])],
      { inserted: false },
    );

    await expect(saveMeasured()).resolves.toEqual({ kind: 'skipped', reason: 'duplicate_session_id' });

    expect(txSelect).toHaveBeenCalledTimes(2);
    expect(updateSet).toHaveBeenCalledOnce();
    expect(updateSet).toHaveBeenCalledWith({ sourceDeviceKey: '30' });
    expect(deleteFn).not.toHaveBeenCalled();
  });
});
