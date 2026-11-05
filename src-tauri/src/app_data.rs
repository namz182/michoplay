use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Manager};

fn open(app: &AppHandle) -> Result<Connection, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "MichoPlay’s app storage is unavailable.".to_owned())?;
    std::fs::create_dir_all(&directory)
        .map_err(|_| "MichoPlay couldn’t create its app storage.".to_owned())?;
    let mut connection = Connection::open(directory.join("app-data.sqlite"))
        .map_err(|_| "MichoPlay’s saved settings could not be opened.".to_owned())?;
    let version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
        .map_err(|_| "MichoPlay’s saved settings version could not be read.".to_owned())?;
    if version > 1 {
        return Err("MichoPlay’s saved settings were created by a newer app version.".to_owned());
    }
    if version < 1 {
        let transaction = connection
            .transaction()
            .map_err(|_| "MichoPlay’s saved settings could not be migrated.".to_owned())?;
        transaction
            .execute_batch(
                "CREATE TABLE app_data (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            PRAGMA user_version = 1;",
            )
            .map_err(|_| "MichoPlay’s saved settings could not be migrated.".to_owned())?;
        transaction
            .commit()
            .map_err(|_| "MichoPlay’s saved settings could not be migrated.".to_owned())?;
    }
    Ok(connection)
}

#[tauri::command]
pub(crate) fn app_data_load(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let connection = open(&app)?;
    let mut statement = connection
        .prepare("SELECT key, value FROM app_data")
        .map_err(|_| "MichoPlay’s saved settings could not be read.".to_owned())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "MichoPlay’s saved settings could not be read.".to_owned())?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(|_| "MichoPlay’s saved settings could not be read.".to_owned())
}

#[tauri::command]
pub(crate) fn app_data_migrate(
    app: AppHandle,
    entries: HashMap<String, String>,
) -> Result<(), String> {
    let mut connection = open(&app)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "MichoPlay’s saved settings could not be updated.".to_owned())?;
    {
        let mut insert = transaction
            .prepare("INSERT OR IGNORE INTO app_data(key, value) VALUES (?1, ?2)")
            .map_err(|_| "MichoPlay’s saved settings could not be updated.".to_owned())?;
        for (key, value) in entries {
            insert
                .execute(params![key, value])
                .map_err(|_| "MichoPlay’s saved settings could not be updated.".to_owned())?;
        }
    }
    transaction
        .commit()
        .map_err(|_| "MichoPlay’s saved settings could not be updated.".to_owned())
}

#[tauri::command]
pub(crate) fn app_data_save(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let connection = open(&app)?;
    connection
        .execute(
            "INSERT INTO app_data(key, value, updated_at) VALUES (?1, ?2, unixepoch())
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value],
        )
        .map(|_| ())
        .map_err(|_| "MichoPlay’s saved settings could not be updated.".to_owned())
}

fn read_favorites(connection: &Connection) -> Result<Vec<u64>, String> {
    let saved = connection
        .query_row(
            "SELECT value FROM app_data WHERE key = 'favorites'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "Saved favorites could not be read.".to_owned())?;
    saved
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| "Saved favorites could not be read.".to_owned())
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}

pub(crate) fn favorite_ids(app: &AppHandle) -> Result<Vec<u64>, String> {
    read_favorites(&open(app)?)
}

fn toggle_favorite_in(connection: &mut Connection, track_id: u64) -> Result<Vec<u64>, String> {
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|_| "Saved favorites could not be updated.".to_owned())?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "Saved favorites could not be updated.".to_owned())?;
    let mut favorites = read_favorites(&transaction)?;
    if let Some(index) = favorites.iter().position(|id| *id == track_id) {
        favorites.remove(index);
    } else {
        favorites.push(track_id);
    }
    let value = serde_json::to_string(&favorites)
        .map_err(|_| "Saved favorites could not be updated.".to_owned())?;
    transaction
        .execute(
            "INSERT INTO app_data(key, value, updated_at) VALUES ('favorites', ?1, unixepoch())
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![value],
        )
        .map_err(|_| "Saved favorites could not be updated.".to_owned())?;
    transaction
        .commit()
        .map_err(|_| "Saved favorites could not be updated.".to_owned())?;
    Ok(favorites)
}

pub(crate) fn toggle_favorite(app: &AppHandle, track_id: u64) -> Result<Vec<u64>, String> {
    toggle_favorite_in(&mut open(app)?, track_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_favorite_toggle_persists_both_directions() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE app_data(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);")
            .unwrap();
        assert_eq!(toggle_favorite_in(&mut connection, 42).unwrap(), vec![42]);
        assert_eq!(read_favorites(&connection).unwrap(), vec![42]);
        assert!(toggle_favorite_in(&mut connection, 42).unwrap().is_empty());
        assert!(read_favorites(&connection).unwrap().is_empty());
    }
}
