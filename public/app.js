document.addEventListener('DOMContentLoaded', () => {
    
    // Tab Switching Logic
    const tabs = document.querySelectorAll('.nav-item');
    const contents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = `tab-${tab.dataset.tab}`;
            
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            document.getElementById(targetId).classList.add('active');
        });
    });

    function authHeaders(extra) {
        const params = new URLSearchParams(location.search)
        let token = params.get('token') || sessionStorage.getItem('conarium-console-token') || ''
        if (token) sessionStorage.setItem('conarium-console-token', token)
        const headers = { ...(extra || {}) }
        if (token) {
            headers['Authorization'] = 'Bearer ' + token
            headers['x-csrf-token'] = token
        }
        return headers
    }

    function policyOf(data) {
        if (data && typeof data.policy === 'object' && data.policy) return data.policy
        return data || {}
    }

    function parseList(raw) {
        return String(raw || '')
            .split(/[\n,]+/)
            .map(s => s.trim())
            .filter(Boolean)
    }

    function fillList(id, arr) {
        const el = document.getElementById(id)
        el.value = Array.isArray(arr) ? arr.join('\n') : ''
    }

    function setAllowTablesWarn(empty) {
        const w = document.getElementById('allowTables-warn')
        if (!w) return
        w.hidden = !empty
    }

    // Load Config
    async function loadConfig() {
        try {
            const res = await fetch('/api/config', { headers: authHeaders() })
            if (!res.ok) {
                showToast('Could not load policy (' + res.status + '). Pass ?token=…')
                return
            }
            const data = await res.json()
            const pol = policyOf(data)
            const maxEl = document.getElementById('maxRows')
            maxEl.value = pol.maxRows == null ? '' : String(pol.maxRows)
            fillList('allowTables', pol.allowTables)
            fillList('denyTables', pol.denyTables)
            fillList('maskColumns', pol.maskColumns)
            document.getElementById('allowTools').value = Array.isArray(pol.allowTools) ? pol.allowTools.join(', ') : ''
            document.getElementById('denyTools').value = Array.isArray(pol.denyTools) ? pol.denyTools.join(', ') : ''
            setAllowTablesWarn(!Array.isArray(pol.allowTables) || pol.allowTables.length === 0)
        } catch (e) {
            console.error('Failed to load config', e)
        }
    }

    // Save Config — only the fields this form edits. connectors/audit/profiles stay on the server.
    document.getElementById('config-form').addEventListener('submit', async (e) => {
        e.preventDefault()

        const maxRaw = document.getElementById('maxRows').value
        const body = {
            allowTables: parseList(document.getElementById('allowTables').value),
            denyTables: parseList(document.getElementById('denyTables').value),
            maskColumns: parseList(document.getElementById('maskColumns').value),
            allowTools: parseList(document.getElementById('allowTools').value),
            denyTools: parseList(document.getElementById('denyTools').value),
        }
        if (maxRaw !== '') body.maxRows = parseInt(maxRaw, 10)

        setAllowTablesWarn(body.allowTables.length === 0)

        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(body)
            })
            if (res.ok) {
                const out = await res.json().catch(() => ({}))
                if (out.allowTablesEmpty) setAllowTablesWarn(true)
                showToast('Governance Policy Saved')
            } else {
                showToast('Save failed (' + res.status + ')')
            }
        } catch (e) {
            console.error('Failed to save config', e)
        }
    })

    // Load Audit Logs
    async function loadAudit() {
        try {
            const res = await fetch('/api/audit', { headers: authHeaders() });
            const data = await res.json();
            
            const tbody = document.getElementById('audit-body');
            tbody.innerHTML = '';
            
            if (data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" class="text-center">No audit logs found.</td></tr>`;
                return;
            }

            data.forEach(log => {
                const tr = document.createElement('tr');
                const isDenied = Boolean(log.denied);
                const statusClass = isDenied ? 'status-rejected' : 'status-success';
                const statusText = isDenied ? 'Denied' : 'Allowed';
                const sqlText = String(log.args && log.args.sql ? log.args.sql : (log.query || '-'));
                const hashValue = String(log.hash || '');
                const hashText = hashValue ? hashValue.substring(0, 8) + '...' : '-';

                function tdText(value) {
                    const td = document.createElement('td');
                    td.textContent = String(value);
                    return td;
                }
                function tdCode(value) {
                    const td = document.createElement('td');
                    const code = document.createElement('code');
                    code.textContent = String(value);
                    td.appendChild(code);
                    return td;
                }

                tr.appendChild(tdText(new Date(log.timestamp).toLocaleString()));
                tr.appendChild(tdText(log.actor || 'unknown'));
                tr.appendChild(tdCode(log.tool || '-'));

                const sqlTd = document.createElement('td');
                sqlTd.title = sqlText;
                const sqlCode = document.createElement('code');
                sqlCode.textContent = sqlText.length > 40 ? sqlText.substring(0, 40) + '...' : sqlText;
                sqlTd.appendChild(sqlCode);
                tr.appendChild(sqlTd);

                tr.appendChild(tdText(log.rowsReturned || 0));
                tr.appendChild(tdText(`${log.maskedCount || 0} PII`));

                const statusTd = document.createElement('td');
                const status = document.createElement('span');
                status.className = `status-badge-sm ${statusClass}`;
                status.textContent = statusText;
                statusTd.appendChild(status);
                tr.appendChild(statusTd);

                const hashTd = document.createElement('td');
                hashTd.title = hashValue;
                const hashCode = document.createElement('code');
                hashCode.style.fontSize = '0.75rem';
                hashCode.style.color = 'var(--text-secondary)';
                hashCode.textContent = hashText;
                hashTd.appendChild(hashCode);
                tr.appendChild(hashTd);

                tbody.appendChild(tr);
            });
        } catch (e) {
            console.error('Failed to load audit logs', e);
        }
    }

    document.getElementById('refresh-audit').addEventListener('click', loadAudit);

    // Load Connectors
    async function loadConnectors() {
        try {
            const res = await fetch('/api/connectors', { headers: authHeaders() });
            const data = await res.json();
            
            const list = document.getElementById('connector-list');
            list.innerHTML = '';

            data.forEach(conn => {
                const statusColor = conn.status === 'connected' ? 'var(--success)' : 'var(--danger)';
                const el = document.createElement('div');
                el.className = 'connector-item';
                el.innerHTML = `
                    <div class="connector-info">
                        <h4>${conn.id}</h4>
                        <span>${conn.type}</span>
                    </div>
                    <div style="text-align: right">
                        <div style="color: ${statusColor}; font-weight: 600; font-size: 0.875rem;">
                            ● ${conn.status}
                        </div>
                        <span style="font-size: 0.75rem; color: var(--text-secondary)">${conn.latency}</span>
                    </div>
                `;
                list.appendChild(el);
            });
        } catch (e) {
            console.error('Failed to load connectors', e);
        }
    }

    // --- Live Playground ---
    const pgQuery = document.getElementById('pg-query');
    document.querySelectorAll('.pg-samples .chip').forEach(chip => {
        chip.addEventListener('click', () => { pgQuery.value = chip.dataset.q; });
    });

    function renderRows(rows) {
        return rows.map(r => {
            const lines = Object.entries(r).map(([k, v]) => {
                const masked = v === '[MASKED_PII]';
                return `  <span class="jk">"${k}"</span>: <span class="${masked ? 'jmask' : 'jv'}">${JSON.stringify(v)}</span>`;
            }).join(',\n');
            return `{\n${lines}\n}`;
        }).join(',\n');
    }

    const pgRun = document.getElementById('pg-run');
    if (pgRun) pgRun.addEventListener('click', async () => {
        const query = pgQuery.value.trim();
        const out = document.getElementById('pg-result');
        out.innerHTML = '<div class="loader">Running through Conarium…</div>';
        try {
            const res = await fetch('/api/playground', {
                method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ query })
            });
            const d = await res.json();
            if (d.decision === 'deny') {
                out.innerHTML = `
                    <div class="pg-blocked">
                        <div class="pg-blocked-icon">🛑</div>
                        <div>
                            <h4>BLOCKED by Conarium</h4>
                            <p>${d.reason}</p>
                            <span class="pg-logged">✓ Logged to audit · decision: <code>deny</code></span>
                        </div>
                    </div>`;
            } else {
                out.innerHTML = `
                    <div class="pg-compare">
                        <div class="pg-col pg-raw">
                            <div class="pg-col-head">🔴 RAW — direct DB access</div>
                            <pre>${renderRows(d.raw)}</pre>
                        </div>
                        <div class="pg-arrow">▸</div>
                        <div class="pg-col pg-gov">
                            <div class="pg-col-head">🟢 GOVERNED — through Conarium</div>
                            <pre>${renderRows(d.governed)}</pre>
                        </div>
                    </div>
                    <div class="pg-logged">✓ <strong>${d.maskedCount}</strong> PII field(s) masked · ${d.governed.length} row(s) · logged to audit</div>`;
            }
            loadAudit();
        } catch (e) {
            out.innerHTML = `<div class="pg-blocked"><p>Error: ${e.message}</p></div>`;
        }
    });

    // Toast Utility
    function showToast(msg) {
        const toast = document.getElementById('toast');
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // Initialize
    loadConfig();
    loadAudit();
    loadConnectors();
});
