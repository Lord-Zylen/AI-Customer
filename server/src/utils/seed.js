import '../config/env.js';
import bcrypt from 'bcryptjs';
import { connectDatabase } from '../services/database.service.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import BusinessSettings from '../models/BusinessSettings.js';

const isProduction = process.env.NODE_ENV === 'production';
const adminEmail = (process.env.ADMIN_EMAIL || '').trim();
const adminPassword = process.env.ADMIN_PASSWORD || '';
const printCredentials = process.env.SEED_PRINT_CREDENTIALS === 'true';

await connectDatabase();
await Promise.all([
  User.deleteMany({}),
  Customer.deleteMany({}),
  Conversation.deleteMany({}),
  Message.deleteMany({}),
  BusinessSettings.deleteMany({}),
]);

// Production must never ship with default/demo credentials. Only a real admin
// is created, and only when one is explicitly provided via environment
// variables. In development the demo admin + fixture data stay for convenience.
if (isProduction && adminEmail && adminPassword) {
  await User.create({
    name: 'Administrator',
    email: adminEmail,
    passwordHash: await bcrypt.hash(adminPassword, 12),
    role: 'ADMIN',
  });
  console.log(`Seeded admin user: ${adminEmail}`);
  if (printCredentials) console.log(`Admin password: ${adminPassword}`);
} else if (!isProduction) {
  const demo = {
    name: 'Adwoa Mensah',
    email: 'admin@customer-ai.test',
    passwordHash: await bcrypt.hash('ChangeMe123!', 12),
    role: 'ADMIN',
  };
  await User.create(demo);
  if (printCredentials) console.log('Seeded admin user: admin@customer-ai.test');
  if (printCredentials) console.log('Demo admin password: (development only) provided to the developer');
} else {
  console.log('Production: no admin seeded. Set ADMIN_EMAIL and ADMIN_PASSWORD to create an admin.');
}

// Fixture/demo data only in non-production.
if (!isProduction) {
  await BusinessSettings.create({
    businessName: 'Aseda Foods',
    description: 'A fictional Ghanaian staple-food supplier.',
    location: 'Madina, Accra',
    openingHours: 'Mon–Sat, 8:00 AM–6:00 PM',
    productsServices: 'Maize, rice, beans and cooking oil.',
    prices: '50kg maize bag: GH₵250. Premium rice 5kg: GH₵118.',
    deliveryInformation: 'Delivery is available in Accra. A team member confirms the fee before delivery.',
    paymentInformation: 'Payment details are confirmed by a team member.',
    commonQuestions: 'Ask a human when product availability or delivery fees are not listed.',
  });

  const data = [
    ['John Mensah', '233201112233', 'I want a refund for my order.', 'HUMAN_REQUIRED', false, true],
    ['Ama Boateng', '233241234567', 'How much is the 50kg maize bag?', 'OPEN', true, false],
    ['Kwame Owusu', '233551234567', 'Hello, do you deliver to Tema?', 'OPEN', true, false],
    ['Esi Addo', '233271234567', 'I have a complaint about my delivery.', 'HUMAN_REQUIRED', false, true],
  ];

  for (const [name, phone, content, status, aiEnabled, requiresHuman] of data) {
    const customer = await Customer.create({ name, phone });
    const conversation = await Conversation.create({
      customerId: customer.id,
      status,
      aiEnabled,
      requiresHuman,
      lastMessageAt: new Date(),
    });
    await Message.create({
      conversationId: conversation.id,
      customerId: customer.id,
      content,
      direction: 'INBOUND',
      senderType: 'CUSTOMER',
      aiIntent: requiresHuman ? 'COMPLAINT' : 'GENERAL',
      aiConfidence: requiresHuman ? 0.95 : 0.9,
    });
    if (aiEnabled) {
      await Message.create({
        conversationId: conversation.id,
        customerId: customer.id,
        content: 'Thanks for your message. I am checking the approved business information for you.',
        direction: 'OUTBOUND',
        senderType: 'AI',
        aiConfidence: 0.9,
        aiIntent: 'GENERAL',
      });
    }
  }
}

console.log('Seeding complete.');
process.exit(0);