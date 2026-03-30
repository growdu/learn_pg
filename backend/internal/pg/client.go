package pg

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

// Client implements PostgreSQL Wire Protocol client (no libpq dependency)
type Client struct {
	conn   net.Conn
	reader *bufio.Reader
}

// Connect establishes connection to PostgreSQL
func (c *Client) Connect(host string, port int, user, password, database string) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect to PostgreSQL at %s: %w", addr, err)
	}
	c.conn = conn
	c.reader = bufio.NewReader(conn)

	// Step 1: Send StartupMessage
	if err := c.sendStartupMessage(user, database); err != nil {
		return err
	}

	// Step 2: Handle authentication
	if err := c.handleAuthentication(password); err != nil {
		return err
	}

	// Step 3: Wait for ReadyForQuery
	if err := c.waitReadyForQuery(); err != nil {
		return err
	}

	return nil
}

// sendStartupMessage sends the protocol handshake
func (c *Client) sendStartupMessage(user, database string) error {
	var buf bytes.Buffer
	binary.Write(&buf, binary.BigEndian, int32(0x00030000))
	c.writeCString(&buf, "user", user)
	c.writeCString(&buf, "database", database)
	c.writeCString(&buf, "application_name", "pg-visualizer")
	buf.WriteByte(0)

	length := int32(buf.Len() + 4)
	var lenBuf bytes.Buffer
	binary.Write(&lenBuf, binary.BigEndian, length)
	c.conn.Write(lenBuf.Bytes())
	c.conn.Write(buf.Bytes())
	return nil
}

func (c *Client) writeCString(buf *bytes.Buffer, key, value string) {
	buf.WriteString(key)
	buf.WriteByte(0)
	buf.WriteString(value)
	buf.WriteByte(0)
}

// handleAuthentication processes authentication messages
func (c *Client) handleAuthentication(password string) error {
	msgType, err := c.reader.ReadByte()
	if err != nil {
		return err
	}
	if msgType != 'R' {
		return fmt.Errorf("expected authentication request (R), got %c", msgType)
	}

	length, err := readInt32(c.reader)
	if err != nil {
		return err
	}
	_ = length

	authType, err := readInt32(c.reader)
	if err != nil {
		return err
	}

	switch authType {
	case 0: // AuthenticationOk
		return nil
	case 3: // AuthenticationCleartextPassword
		return c.sendPassword(password)
	case 5: // AuthenticationMD5Password
		salt := make([]byte, 4)
		io.ReadFull(c.reader, salt)
		return c.sendPassword(password) // fallback to plaintext
	default:
		return fmt.Errorf("unsupported authentication type: %d", authType)
	}
}

func readInt32(r *bufio.Reader) (int32, error) {
	var n int32
	err := binary.Read(r, binary.BigEndian, &n)
	return n, err
}

func readInt16(r *bufio.Reader) (int16, error) {
	var n int16
	err := binary.Read(r, binary.BigEndian, &n)
	return n, err
}

// sendPassword sends plaintext password
func (c *Client) sendPassword(password string) error {
	var buf bytes.Buffer
	buf.WriteByte('p')
	payload := password + "\x00"
	binary.Write(&buf, binary.BigEndian, int32(len(payload)+4))
	buf.WriteString(payload)
	_, err := c.conn.Write(buf.Bytes())
	return err
}

// waitReadyForQuery consumes messages until ReadyForQuery
func (c *Client) waitReadyForQuery() error {
	for {
		msgType, err := c.reader.ReadByte()
		if err != nil {
			return err
		}
		length, err := readInt32(c.reader)
		if err != nil {
			return err
		}
		_ = length

		switch msgType {
		case 'Z':
			return nil
		case 'E':
			// consume error
			for {
				b, err := c.reader.ReadByte()
				if err != nil || b == 0 {
					break
				}
			}
			return nil
		default:
			remaining := int(length) - 4
			if remaining > 0 {
				c.reader.Discard(remaining)
			}
		}
	}
}

// Execute runs a SQL query and returns result
func (c *Client) Execute(sql string) (*ExecuteResult, error) {
	if err := c.sendQuery(sql); err != nil {
		return nil, err
	}

	result := &ExecuteResult{Rows: []map[string]string{}}

	for {
		msgType, err := c.reader.ReadByte()
		if err != nil {
			return nil, err
		}
		length, err := readInt32(c.reader)
		if err != nil {
			return nil, err
		}

		switch msgType {
		case 'C': // CommandComplete
			cmdTag, _ := c.readCString()
			result.CommandTag = cmdTag
		case 'T': // RowDescription
			cols, err := c.readRowDescription()
			if err != nil {
				return nil, err
			}
			result.Columns = cols
		case 'D': // DataRow
			row, err := c.readDataRow(result.Columns)
			if err != nil {
				return nil, err
			}
			result.Rows = append(result.Rows, row)
		case 'Z': // ReadyForQuery
			return result, nil
		case 'E': // ErrorResponse
			errMsg, _ := c.readErrorResponse()
			result.Error = errMsg
			return result, nil
		case 'I': // EmptyQueryResponse
			return result, nil
		default:
			remaining := int(length) - 4
			if remaining > 0 {
				c.reader.Discard(remaining)
			}
		}
	}
}

func (c *Client) sendQuery(sql string) error {
	var buf bytes.Buffer
	buf.WriteByte('Q')
	payload := sql + "\x00"
	binary.Write(&buf, binary.BigEndian, int32(len(payload)+4))
	buf.WriteString(payload)
	_, err := c.conn.Write(buf.Bytes())
	return err
}

func (c *Client) readRowDescription() ([]Column, error) {
	fieldCount, err := readInt16(c.reader)
	if err != nil {
		return nil, err
	}

	cols := make([]Column, fieldCount)
	for i := range cols {
		name, _ := c.readCStringBytes()
		c.reader.Discard(4) // table OID
		c.reader.Discard(2) // column index
		dataTypeOID, _ := readInt32(c.reader)
		c.reader.Discard(2) // type size
		c.reader.Discard(2) // format code

		cols[i] = Column{Name: string(name), Type: uint32(dataTypeOID)}
	}
	return cols, nil
}

func (c *Client) readDataRow(cols []Column) (map[string]string, error) {
	fieldCount, err := readInt16(c.reader)
	if err != nil {
		return nil, err
	}

	row := make(map[string]string)
	for i := 0; i < int(fieldCount); i++ {
		colLen, err := readInt32(c.reader)
		if err != nil {
			return nil, err
		}
		value := ""
		if colLen != -1 {
			data := make([]byte, colLen)
			io.ReadFull(c.reader, data)
			value = string(data)
		}
		if i < len(cols) {
			row[cols[i].Name] = value
		}
	}
	return row, nil
}

func (c *Client) readErrorResponse() (string, map[string]string) {
	details := make(map[string]string)
	var msg string

	for {
		fieldType, err := c.reader.ReadByte()
		if err != nil || fieldType == 0 {
			break
		}
		value, _ := c.readCStringBytes()
		details[string(fieldType)] = string(value)
		if fieldType == 'M' {
			msg = string(value)
		}
	}
	return msg, details
}

func (c *Client) readCString() (string, error) {
	s, err := c.readCStringBytes()
	return string(s), err
}

func (c *Client) readCStringBytes() ([]byte, error) {
	var buf bytes.Buffer
	for {
		b, err := c.reader.ReadByte()
		if err != nil {
			return nil, err
		}
		if b == 0 {
			break
		}
		buf.WriteByte(b)
	}
	return buf.Bytes(), nil
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
		return errors.New("not connected")
	}
	_, err := c.Execute("SELECT 1")
	return err
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
	var out strings.Builder
	if r.Error != "" {
		out.WriteString("ERROR: " + r.Error + "\n")
		return out.String()
	}
	for _, col := range r.Columns {
		out.WriteString(col.Name + "\t")
	}
	out.WriteString("\n")
	for _, row := range r.Rows {
		for _, col := range r.Columns {
			out.WriteString(row[col.Name] + "\t")
		}
		out.WriteString("\n")
	}
	if r.CommandTag != "" {
		out.WriteString("(" + r.CommandTag + ")\n")
	}
	return out.String()
}