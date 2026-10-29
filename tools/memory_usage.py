import tracemalloc

tracemalloc.start()

with open("app/database.py", "r", encoding="utf-8") as f:
    data = f.read()  # the entire file becomes one string in memory

snapshot = tracemalloc.take_snapshot()
for stat in snapshot.statistics("lineno")[:3]:
    print(stat)

current, peak = tracemalloc.get_traced_memory()
print(f"current={current / 1e6:.1f} MB, peak={peak / 1e6:.1f} MB")