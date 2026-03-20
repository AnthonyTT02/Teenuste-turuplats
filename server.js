const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

const frontendDistPath = path.join(__dirname, 'frontend', 'dist');
const frontendIndexPath = path.join(frontendDistPath, 'index.html');
const hasFrontendBuild = fs.existsSync(frontendIndexPath);

if (hasFrontendBuild) {
	app.use(express.static(frontendDistPath));
}

app.use(express.static(path.join(__dirname)));

function hashPassword(password) {
	return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

function haversineDistance(lat1, lon1, lat2, lon2) {
	const R = 6371;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
		Math.sin(dLon / 2) * Math.sin(dLon / 2);
	return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function verifyCompanyAccess(userId, providerId) {
	const [rows] = await pool.query(
		'SELECT id FROM users WHERE id = ? AND role = ? AND provider_id = ?',
		[userId, 'company', providerId]
	);
	return Array.isArray(rows) && rows.length > 0;
}

// Basic health endpoint
app.get('/db-test', async (req, res) => {
	try {
		const [rows] = await pool.query('SELECT 1 + 1 AS result');
		res.json({ ok: true, result: rows[0].result });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/register-user', async (req, res) => {
	try {
		const { username, password, phone } = req.body || {};
		if (!username || !password || !phone) {
			return res.status(400).json({ ok: false, error: 'Имя пользователя, пароль и телефон обязательны' });
		}
		if (String(password).length < 3) {
			return res.status(400).json({ ok: false, error: 'Пароль должен быть минимум 3 символа' });
		}

		const [result] = await pool.query(
			'INSERT INTO users (username, password, phone) VALUES (?, ?, ?)',
			[username, hashPassword(password), phone]
		);
		res.json({ ok: true, userId: result.insertId, message: 'Аккаунт создан успешно!' });
	} catch (err) {
		if (err.code === 'ER_DUP_ENTRY') {
			return res.status(400).json({ ok: false, error: 'Это имя пользователя уже занято' });
		}
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/login', async (req, res) => {
	try {
		const { username, password } = req.body || {};
		if (!username || !password) {
			return res.status(400).json({ ok: false, error: 'Имя пользователя и пароль обязательны' });
		}

		const [rows] = await pool.query(
			'SELECT id, username, role, provider_id FROM users WHERE username = ? AND password = ?',
			[username, hashPassword(password)]
		);

		if (!rows || rows.length === 0) {
			return res.status(401).json({ ok: false, error: 'Неправильное имя пользователя или пароль' });
		}

		const user = rows[0];
		res.json({ ok: true, userId: user.id, role: user.role || 'user', providerId: user.provider_id || null });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/company-login', async (req, res) => {
	try {
		const { username, password } = req.body || {};
		if (!username || !password) {
			return res.status(400).json({ ok: false, error: 'Логин и пароль обязательны' });
		}

		const [rows] = await pool.query(
			'SELECT id, username, provider_id FROM users WHERE username = ? AND password = ? AND role = ?',
			[username, hashPassword(password), 'company']
		);

		if (!rows || rows.length === 0) {
			return res.status(401).json({ ok: false, error: 'Неправильный логин или пароль компании' });
		}

		const user = rows[0];
		res.json({ ok: true, userId: user.id, providerId: user.provider_id, companyName: user.username });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/validate-provider', async (req, res) => {
	try {
		const { companyName, regNumber, accountNumber } = req.body || {};
		if (!companyName && !regNumber && !accountNumber) {
			return res.status(400).json({ ok: false, error: 'At least one field required' });
		}

		const conditions = [];
		const values = [];
		if (companyName) {
			conditions.push('companyName = ?');
			values.push(companyName);
		}
		if (regNumber) {
			conditions.push('regNumber = ?');
			values.push(regNumber);
		}
		if (accountNumber) {
			conditions.push('accountNumber = ?');
			values.push(accountNumber);
		}

		const [rows] = await pool.query(
			`SELECT id, companyName, regNumber, accountNumber FROM providers WHERE ${conditions.join(' OR ')}`,
			values
		);

		if (rows.length > 0) {
			return res.status(400).json({ ok: false, error: 'Один из реквизитов уже используется' });
		}

		res.json({ ok: true, message: 'Данные доступны для регистрации' });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/register-provider-full', async (req, res) => {
	try {
		const {
			services,
			companyName,
			regNumber,
			lat,
			lng,
			companyCars,
			ownerName,
			ownerEmail,
			ownerPhone,
			companyLogin,
			companyPassword,
			companyPhone,
			accountNumber,
			iban,
			kmkr,
			employees
		} = req.body || {};

		if (!companyName || !regNumber || !ownerName || !ownerEmail || !ownerPhone || !accountNumber || !iban) {
			return res.status(400).json({ ok: false, error: 'Missing required fields' });
		}

		const [providerResult] = await pool.query(
			`INSERT INTO providers (companyName, regNumber, accountNumber, iban, kmkr, ownerName, ownerEmail, ownerPhone, lat, lng, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
			[companyName, regNumber, accountNumber, iban, kmkr || null, ownerName, ownerEmail, ownerPhone, lat || null, lng || null]
		);

		const providerId = providerResult.insertId;

		for (const car of Array.isArray(companyCars) ? companyCars : []) {
			if (car && String(car).trim()) {
				await pool.query('INSERT INTO company_cars (provider_id, name) VALUES (?, ?)', [providerId, String(car).trim()]);
			}
		}

		for (const emp of Array.isArray(employees) ? employees : []) {
			if (emp && emp.name && emp.phone) {
				await pool.query(
					'INSERT INTO company_employees (provider_id, name, phone, languages) VALUES (?, ?, ?, ?)',
					[providerId, emp.name, emp.phone, emp.languages ? JSON.stringify(emp.languages) : null]
				);
			}
		}

		if (services && typeof services === 'object') {
			for (const [serviceName, serviceData] of Object.entries(services)) {
				let serviceId = null;
				let price = null;

				if (serviceData && typeof serviceData === 'object') {
					serviceId = serviceData.id || null;
					price = serviceData.price || null;
				} else {
					price = serviceData;
					const [serviceRows] = await pool.query('SELECT id FROM services WHERE name = ?', [serviceName]);
					if (serviceRows.length > 0) serviceId = serviceRows[0].id;
				}

				if (serviceId && Number(price) > 0) {
					await pool.query(
						'INSERT INTO provider_services (provider_id, service_id, price) VALUES (?, ?, ?)',
						[providerId, serviceId, Number(price)]
					);
				}
			}
		}

		if (companyLogin && companyPassword) {
			try {
				await pool.query(
					'INSERT INTO users (username, password, phone, role, provider_id) VALUES (?, ?, ?, ?, ?)',
					[companyLogin, hashPassword(companyPassword), companyPhone || null, 'company', providerId]
				);
			} catch (_) {
				// Keep provider registration successful even if company account already exists.
			}
		}

		res.json({ ok: true, providerId, message: 'Provider registered successfully' });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/services', async (req, res) => {
	try {
		const [rows] = await pool.query('SELECT id, name FROM services ORDER BY id');
		res.json({ ok: true, services: rows });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/order', async (req, res) => {
	try {
		const { vehicleBrand, vehicleModel, regNumber, services, address, lat, lng, paymentType, userId } = req.body || {};
		const [result] = await pool.query(
			`INSERT INTO orders (vehicleBrand, vehicleModel, regNumber, services, address, lat, lng, paymentType, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				vehicleBrand || null,
				vehicleModel || null,
				regNumber || null,
				JSON.stringify(Array.isArray(services) ? services : []),
				address || null,
				lat || null,
				lng || null,
				paymentType || null,
				userId || null
			]
		);
		res.json({ ok: true, orderId: result.insertId });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/orders/:id', async (req, res) => {
	try {
		const [rows] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
		if (!rows || rows.length === 0) return res.status(404).json({ ok: false, error: 'Not found' });
		res.json({ ok: true, order: rows[0] });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/user/:id', async (req, res) => {
	try {
		const [rows] = await pool.query('SELECT id, username, phone FROM users WHERE id = ?', [req.params.id]);
		if (!rows || rows.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
		res.json({ ok: true, user: rows[0] });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/user/:userId/orders/active', async (req, res) => {
	try {
		const [rows] = await pool.query(
			`SELECT o.*, p.companyName, p.ownerPhone, ce.name as employee_name, cc.name as car_name
			 FROM orders o
			 LEFT JOIN providers p ON o.provider_id = p.id
			 LEFT JOIN company_employees ce ON o.employee_id = ce.id
			 LEFT JOIN company_cars cc ON o.car_id = cc.id
			 WHERE o.user_id = ? AND o.completed_at IS NULL
			 ORDER BY o.created_at DESC`,
			[req.params.userId]
		);
		res.json({ ok: true, orders: rows || [] });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/user/:userId/orders/completed', async (req, res) => {
	try {
		const [rows] = await pool.query(
			`SELECT o.*, p.companyName, p.ownerPhone, ce.name as employee_name, cc.name as car_name
			 FROM orders o
			 LEFT JOIN providers p ON o.provider_id = p.id
			 LEFT JOIN company_employees ce ON o.employee_id = ce.id
			 LEFT JOIN company_cars cc ON o.car_id = cc.id
			 WHERE o.user_id = ? AND o.completed_at IS NOT NULL
			 ORDER BY o.completed_at DESC`,
			[req.params.userId]
		);
		res.json({ ok: true, orders: rows || [] });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/provider/:id', async (req, res) => {
	try {
		const providerId = req.params.id;
		const userId = req.query.userId || req.headers['x-user-id'];

		if (!userId || !(await verifyCompanyAccess(userId, providerId))) {
			return res.status(403).json({ ok: false, error: 'Access denied' });
		}

		const [providers] = await pool.query('SELECT * FROM providers WHERE id = ?', [providerId]);
		if (!providers || providers.length === 0) {
			return res.status(404).json({ ok: false, error: 'Provider not found' });
		}

		const provider = providers[0];

		try {
			const [cars] = await pool.query('SELECT id, name, regNumber FROM company_cars WHERE provider_id = ? ORDER BY created_at ASC', [providerId]);
			provider.cars = (cars || []).map((c) => ({ id: c.id, regNumber: c.name || c.regNumber || '' }));
		} catch (_) {
			provider.cars = [];
		}

		try {
			const [employees] = await pool.query(
				'SELECT id, name, phone, languages FROM company_employees WHERE provider_id = ? ORDER BY created_at ASC',
				[providerId]
			);
			provider.employees = (employees || []).map((e) => ({
				id: String(e.id),
				name: e.name,
				phone: e.phone,
				languages: e.languages ? JSON.parse(e.languages) : []
			}));
		} catch (_) {
			provider.employees = [];
		}

		res.json({ ok: true, provider });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/provider/:id/orders', async (req, res) => {
	try {
		const providerId = req.params.id;
		const userId = req.query.userId || req.headers['x-user-id'];
		if (!userId || !(await verifyCompanyAccess(userId, providerId))) {
			return res.status(403).json({ ok: false, error: 'Access denied' });
		}

		const [rows] = await pool.query(
			'SELECT id, vehicleBrand, vehicleModel, regNumber, services, address, lat, lng, paymentType, created_at FROM orders WHERE provider_id = ? AND completed_at IS NULL ORDER BY created_at DESC',
			[providerId]
		);
		res.json({ ok: true, orders: rows || [] });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/provider/:id/car', async (req, res) => {
	try {
		const providerId = req.params.id;
		const userId = req.body.userId || req.query.userId || req.headers['x-user-id'];
		if (!userId || !(await verifyCompanyAccess(userId, providerId))) {
			return res.status(403).json({ ok: false, error: 'Access denied' });
		}

		const plate = (req.body.regNumber || req.body.name || '').trim();
		if (!plate) return res.status(400).json({ ok: false, error: 'regNumber required' });

		const [result] = await pool.query('INSERT INTO company_cars (provider_id, name) VALUES (?, ?)', [providerId, plate]);
		res.json({ ok: true, insertId: result.insertId, plate });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.delete('/api/provider/:id/car/:carId', async (req, res) => {
	try {
		const { id, carId } = req.params;
		const userId = req.query.userId || req.headers['x-user-id'];
		if (!userId || !(await verifyCompanyAccess(userId, id))) {
			return res.status(403).json({ ok: false, error: 'Access denied' });
		}

		await pool.query('DELETE FROM company_cars WHERE id = ? AND provider_id = ?', [carId, id]);
		res.json({ ok: true });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/provider/:id/employee', async (req, res) => {
	try {
		const providerId = req.params.id;
		const userId = req.body.userId || req.query.userId || req.headers['x-user-id'];
		const { name, phone, languages } = req.body || {};

		if (!userId || !(await verifyCompanyAccess(userId, providerId))) {
			return res.status(403).json({ ok: false, error: 'Access denied' });
		}
		if (!name || !phone) {
			return res.status(400).json({ ok: false, error: 'name and phone required' });
		}

		const [result] = await pool.query(
			'INSERT INTO company_employees (provider_id, name, phone, languages, is_online) VALUES (?, ?, ?, ?, true)',
			[providerId, name, phone, languages ? JSON.stringify(languages) : null]
		);
		res.json({ ok: true, employeeId: result.insertId });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.delete('/api/provider/:id/employee/:empId', async (req, res) => {
	try {
		const { id, empId } = req.params;
		const userId = req.query.userId || req.headers['x-user-id'];
		if (!userId || !(await verifyCompanyAccess(userId, id))) {
			return res.status(403).json({ ok: false, error: 'Access denied' });
		}

		await pool.query('DELETE FROM company_employees WHERE id = ? AND provider_id = ?', [empId, id]);
		res.json({ ok: true });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/employee/:id', async (req, res) => {
	try {
		const [rows] = await pool.query('SELECT id, name, phone, languages, is_online FROM company_employees WHERE id = ?', [req.params.id]);
		if (!rows || rows.length === 0) return res.status(404).json({ ok: false, error: 'Employee not found' });
		res.json({ ok: true, employee: rows[0] });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.patch('/api/employee/:empId/status', async (req, res) => {
	try {
		const { isOnline } = req.body || {};
		if (typeof isOnline !== 'boolean') {
			return res.status(400).json({ ok: false, error: 'isOnline must be boolean' });
		}
		await pool.query('UPDATE company_employees SET is_online = ? WHERE id = ?', [isOnline, req.params.empId]);
		res.json({ ok: true });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/car/:id', async (req, res) => {
	try {
		const [rows] = await pool.query('SELECT id, name, provider_id, is_online FROM company_cars WHERE id = ?', [req.params.id]);
		if (!rows || rows.length === 0) return res.status(404).json({ ok: false, error: 'Car not found' });
		res.json({ ok: true, car: rows[0] });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/providers-for-service/:serviceId', async (req, res) => {
	try {
		const { serviceId } = req.params;
		const [providers] = await pool.query(
			`SELECT DISTINCT p.id, p.companyName, p.lat, p.lng, p.ownerPhone, ps.price
			 FROM providers p
			 JOIN provider_services ps ON p.id = ps.provider_id
			 WHERE ps.service_id = ?
			 ORDER BY p.id`,
			[serviceId]
		);

		const result = [];
		for (const provider of providers || []) {
			let employees = [];
			let cars = [];

			try {
				const [rows] = await pool.query(
					'SELECT id, name, phone, languages FROM company_employees WHERE provider_id = ? AND is_online = true',
					[provider.id]
				);
				employees = rows || [];
			} catch {
				const [rows] = await pool.query('SELECT id, name, phone, languages FROM company_employees WHERE provider_id = ?', [provider.id]);
				employees = rows || [];
			}

			try {
				const [rows] = await pool.query('SELECT id, name FROM company_cars WHERE provider_id = ? AND is_online = true', [provider.id]);
				cars = rows || [];
			} catch {
				const [rows] = await pool.query('SELECT id, name FROM company_cars WHERE provider_id = ?', [provider.id]);
				cars = rows || [];
			}

			result.push({ ...provider, onlineEmployees: employees, onlineCars: cars });
		}

		res.json({ ok: true, providers: result.filter((p) => p.onlineEmployees.length > 0 && p.onlineCars.length > 0) });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/api/providers/prices', async (req, res) => {
	try {
		const orderId = req.query.orderId;
		if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });

		const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
		if (!orders || orders.length === 0) return res.status(404).json({ ok: false, error: 'Order not found' });
		const order = orders[0];

		const serviceIds = JSON.parse(order.services || '[]');
		const [providers] = await pool.query('SELECT id, companyName, ownerName, ownerPhone, lat, lng FROM providers');

		const results = [];
		for (const p of providers || []) {
			let total = 0;
			const breakdown = [];

			if (Array.isArray(serviceIds) && serviceIds.length > 0) {
				const placeholders = serviceIds.map(() => '?').join(',');
				const [rows] = await pool.query(
					`SELECT s.id as service_id, s.name, ps.price
					 FROM provider_services ps
					 JOIN services s ON ps.service_id = s.id
					 WHERE ps.provider_id = ? AND s.id IN (${placeholders})`,
					[p.id, ...serviceIds]
				);

				for (const r of rows || []) {
					const price = Number(r.price || 0);
					total += price;
					breakdown.push({ service_id: r.service_id, name: r.name, price });
				}
			}

			let distance = null;
			let eta_minutes = Math.floor(Math.random() * 36) + 10;
			if (p.lat && p.lng && order.lat && order.lng) {
				distance = haversineDistance(order.lat, order.lng, p.lat, p.lng);
				const baseEta = Math.round((distance / 40) * 60);
				const jitter = Math.floor(Math.random() * 11) - 5;
				eta_minutes = Math.max(10, Math.min(45, baseEta + jitter));
			}

			results.push({ provider: p, total, breakdown, distance, eta_minutes });
		}

		res.json({ ok: true, providers: results, order });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/order/attach', async (req, res) => {
	try {
		const { orderId, providerId, employeeId, carId } = req.body || {};
		if (!orderId || !providerId) {
			return res.status(400).json({ ok: false, error: 'orderId and providerId required' });
		}

		await pool.query(
			'UPDATE orders SET provider_id = ?, employee_id = ?, car_id = ? WHERE id = ?',
			[providerId, employeeId || null, carId || null, orderId]
		);
		res.json({ ok: true });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/order/:orderId/complete', async (req, res) => {
	try {
		await pool.query('UPDATE orders SET completed_at = NOW() WHERE id = ?', [req.params.orderId]);
		res.json({ ok: true, message: 'Order completed successfully' });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.use((err, req, res, next) => {
	if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
		return res.status(400).json({ ok: false, error: 'Некорректный JSON' });
	}
	return res.status(500).json({ ok: false, error: err.message || 'Ошибка сервера' });
});

if (hasFrontendBuild) {
	app.get('*', (req, res, next) => {
		if (req.path.startsWith('/api') || req.path === '/db-test' || path.extname(req.path)) {
			return next();
		}
		return res.sendFile(frontendIndexPath);
	});
}

app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
