"""灵图工作台本地 FastAPI 服务入口。"""

from fastapi import FastAPI

app = FastAPI(title="灵图工作台本地服务", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    """提供桌面壳启动时使用的最小健康检查。"""

    return {"status": "ok", "service": "lingtu-workbench"}


if __name__ == "__main__":
    import uvicorn

    # 开发阶段只监听本机，避免把本地服务暴露到局域网。
    uvicorn.run("backend.app.main:app", host="127.0.0.1", port=8765, reload=True)
