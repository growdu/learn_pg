package pg

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/lib/pq"
)

// Client wraps sql.DB for PostgreSQL connections
type Client struct {
	conn *sql.DB
}

// Connect establishes connection to PostgreSQL
func (c *Client) Connect(host string, port int, user, password, database string) error {
	dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable",
		host, port, user, password, database)

	conn, err := sql.Open("postgres", dsn)
	if err != nil {
		return fmt.Errorf("failed to connect to PostgreSQL: %w", err)
	}

	// Set connection timeout
	conn.SetMaxOpenConns(10)
	conn.SetMaxIdleConns(5)
	conn.SetConnMaxLifetime(5 * time.Minute)

	// Verify connection
	if err := conn.Ping(); err != nil {
		conn.Close()
		return fmt.Errorf("failed to ping PostgreSQL: %w", err)
	}

	c.conn = conn
	return nil
}

// Close closes the connection
func (c *Client) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

// Ping checks if the connection is alive
func (c *Client) Ping() error {
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}
	return c.conn.Ping()
}

// Execute runs a SQL query and returns result
func (c *Client) Execute(sql string) (*ExecuteResult, error) {
	if c.conn == nil {
		return nil, fmt.Errorf("not connected")
	}

	rows, err := c.conn.Query(sql)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Get column names
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}

	colTypes, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}

	result := &ExecuteResult{
		Columns:    make([]Column, len(columns)),
		Rows:       []map[string]string{},
		CommandTag: "",
	}

	for i, col := range columns {
		result.Columns[i] = Column{
			Name: col,
			Type: 0, // lib/pq doesn't provide OID directly in simple way
		}
		_ = colTypes // can be used for type info if needed
	}

	// Scan rows
	for rows.Next() {
		// Create slice of pointers for scan
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range values {
			valuePtrs[i] = &values[i]
		}

		if err := rows.Scan(valuePtrs...); err != nil {
			return nil, err
		}

		// Convert to map
		row := make(map[string]string)
		for i, col := range columns {
			if values[i] != nil {
				row[col] = fmt.Sprintf("%v", values[i])
			}
		}
		result.Rows = append(result.Rows, row)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return result, nil
}

// GetVersion returns PostgreSQL server version
func (c *Client) GetVersion() (string, error) {
	result, err := c.Execute("SELECT version()")
	if err != nil {
		return "", err
	}
	if len(result.Rows) > 0 {
		if v, ok := result.Rows[0]["version"]; ok {
			return v, nil
		}
	}
	return "", nil
}

// GetPGDataDir returns the PG data directory path
func (c *Client) GetPGDataDir() (string, error) {
	result, err := c.Execute("SHOW data_directory")
	if err != nil {
		return "", err
	}
	if len(result.Rows) > 0 {
		if d, ok := result.Rows[0]["data_directory"]; ok {
			return d, nil
		}
	}
	return "", nil
}

// GetCurrentXLogPos returns current WAL write position
func (c *Client) GetCurrentXLogPos() (string, error) {
	result, err := c.Execute("SELECT pg_current_wal_lsn() as lsn")
	if err != nil {
		return "", err
	}
	if len(result.Rows) > 0 {
		if lsn, ok := result.Rows[0]["lsn"]; ok {
			return lsn, nil
		}
	}
	return "", nil
}

// ExecuteResult holds the result of a query execution
type ExecuteResult struct {
	Columns    []Column
	Rows        []map[string]string
	CommandTag  string
	Error       string
	ErrorDetail map[string]string
}

// Column describes a result column
type Column struct {
	Name string
	Type uint32
}

// GetSQLResult returns a human-readable string
func (r *ExecuteResult) String() string {
	var result string
	for _, col := range r.Columns {
		result += col.Name + "\t"
	}
	result += "\n"
	for _, row := range r.Rows {
		for _, col := range r.Columns {
			result += row[col.Name] + "\t"
		}
		result += "\n"
	}
	if r.CommandTag != "" {
		result += "(" + r.CommandTag + ")\n"
	}
	return result
}
