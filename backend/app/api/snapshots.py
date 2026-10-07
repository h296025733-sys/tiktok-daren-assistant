from fastapi import APIRouter, HTTPException, Query, status

from app.models.snapshot import SnapshotCreate, SnapshotList, SnapshotRecord
from app.storage.database import get_latest_snapshot, insert_snapshot, list_snapshots


router = APIRouter(prefix="/api/v1/snapshots", tags=["snapshots"])


@router.post("", response_model=SnapshotRecord, status_code=status.HTTP_201_CREATED)
def create_snapshot(snapshot: SnapshotCreate) -> SnapshotRecord:
    return SnapshotRecord.model_validate(insert_snapshot(snapshot))


@router.get("/latest", response_model=SnapshotRecord)
def latest_snapshot() -> SnapshotRecord:
    snapshot = get_latest_snapshot()
    if snapshot is None:
        raise HTTPException(status_code=404, detail="暂无已保存数据")
    return SnapshotRecord.model_validate(snapshot)


@router.get("", response_model=SnapshotList)
def snapshots(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> SnapshotList:
    items, total = list_snapshots(limit, offset)
    return SnapshotList(
        items=[SnapshotRecord.model_validate(item) for item in items],
        total=total,
        limit=limit,
        offset=offset,
    )

