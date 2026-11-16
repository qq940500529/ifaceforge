from fastapi import FastAPI

app = FastAPI(title="Synthetic inventory")


@app.get("/inventory/{item_id}")
async def read_item(item_id: int):
    return {"id": item_id, "count": 3}
