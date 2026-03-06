import os
import sqlite3

DB_PATH = os.getenv("DB_PATH","companyhub.db")

def init_db():

os.makedirs(os.path.dirname(DB_PATH) or ".",exist_ok=True)

con = sqlite3.connect(DB_PATH)

cur = con.cursor()

cur.execute("""
CREATE TABLE IF NOT EXISTS trains(
id INTEGER PRIMARY KEY,
buyer TEXT,
amount INTEGER
)
""")

cur.execute("""
CREATE TABLE IF NOT EXISTS users(
id TEXT PRIMARY KEY,
api_key TEXT
)
""")

con.commit()
con.close()
