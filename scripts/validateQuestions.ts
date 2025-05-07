import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'fs';
import path from 'path';

// Initialize Supabase client
const supabaseUrl = 'https://gjvtncdjcslnkfctqnfy.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseKey) {
  console.error('❌ SUPABASE_SERVICE_KEY is required in environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize OpenAI client for DeepSeek
const deepseekKey = process.env.DEEPSEEK_API_KEY;

if (!deepseekKey) {
  console.error('❌ DEEPSEEK_API_KEY is required in environment variables');
  process.exit(1);
}

const deepseek = new OpenAI({
  apiKey: deepseekKey,
  baseURL: 'https://api.deepseek.com/v1',
});

// Define the system prompt for the model
const systemPrompt = `You are a mathematical validation system specializing in analyzing questions about monomials ("monomios" in Portuguese). Your task is to verify if these questions are correct, clear, and educationally sound.

Assessment criteria for valid monomial questions:
1. Mathematical accuracy - All mathematical statements, equations, and answers must be correct
2. Clarity - Questions must have clear statements and unambiguous solutions
3. Educational value - Questions must focus on teaching monomial concepts effectively
4. Correct answer - The marked correct option must actually be correct

Important monomial topics to verify:
- Definition of monomials (expression with one term)
- Degree of monomials (sum of variable exponents)
- Coefficient identification
- Monomial operations (addition, subtraction, multiplication, division)
- Like and unlike terms
- Simplification rules

You will analyze each question's statement, options, and solution, and return a JSON response with the following fields:
- "is_valid": Boolean indicating if the question meets all criteria
- "reason": String explaining why the question is valid or not
- "fixed_correct_option": Number (0, 1, or 2) indicating the fixed correct option index, or null if no fix needed
- "fixed_statement_md": String with fixed statement in Markdown format, or null if no fix needed
- "fixed_solution_md": String with fixed solution in Markdown format, or null if no fix needed

Examples:

Example 1 (Valid Question):
{
  "statement": "Qual é o coeficiente do monômio 5x²y³?",
  "options": ["5", "x²y³", "5x²"],
  "correct_option": 0,
  "solution": "O coeficiente de um monômio é o fator numérico. Em 5x²y³, o coeficiente é 5."
}
Response:
{
  "is_valid": true,
  "reason": "The question is mathematically accurate as it correctly identifies the coefficient in a monomial. The statement is clear, the correct option is properly marked, and the solution provides adequate explanation.",
  "fixed_correct_option": null,
  "fixed_statement_md": null,
  "fixed_solution_md": null
}

Example 2 (Invalid with Correction):
{
  "statement": "Qual é o grau do monômio 3x²y?",
  "options": ["2", "3", "5"],
  "correct_option": 1,
  "solution": "O grau do monômio 3x²y é 3, pois somamos os expoentes: 2 + 1 = 3."
}
Response:
{
  "is_valid": false,
  "reason": "The question has an incorrect answer marked. The degree of the monomial 3x²y is indeed the sum of the exponents of the variables, which is 2 + 1 = 3. However, this corresponds to option index 0 (value '2'), not index 1 (value '3').",
  "fixed_correct_option": 0,
  "fixed_statement_md": null,
  "fixed_solution_md": "O grau do monômio 3x²y é 3, pois somamos os expoentes das variáveis: 2 (expoente de x) + 1 (expoente de y) = 3."
}

Example 3 (Invalid with Multiple Fixes):
{
  "statement": "Qual é o resultado da multiplicação dos monômios 2x³ e 4x²?",
  "options": ["6x⁵", "6x⁶", "8x⁵"],
  "correct_option": 1,
  "solution": "Multiplicamos os coeficientes e somamos os expoentes: 2 × 4 = 6, e x³ × x² = x⁵. Portanto, o resultado é 6x⁵."
}
Response:
{
  "is_valid": false,
  "reason": "There are multiple issues: the correct answer is 6x⁵ (option index 0), not 6x⁶ (option index 1). The solution correctly calculates 2×4=8 and x³×x²=x⁵, but the correct result is 8x⁵, which isn't listed in the options.",
  "fixed_correct_option": 0,
  "fixed_statement_md": null,
  "fixed_solution_md": "Multiplicamos os coeficientes e somamos os expoentes: 2 × 4 = 8, e x³ × x² = x³⁺² = x⁵. Portanto, o resultado é 8x⁵."
}

IMPORTANT: Always return a valid JSON without any additional text. Verify mathematical concepts carefully before flagging issues.`;

// Ensure the audit log directory exists
const logDir = path.dirname('audit.log');
if (!fs.existsSync(logDir) && logDir !== '') {
  fs.mkdirSync(logDir, { recursive: true });
}

// Create a write stream for the audit log
const logStream = fs.createWriteStream('audit.log', { flags: 'a' });

// Helper function to log to both console and file
function log(message: string) {
  console.log(message);
  logStream.write(message + '\n');
}

// Function to get topic from command line arguments or default to 'monomios'
function getTopic(): string {
  const args = process.argv.slice(2);
  const topicArg = args.find(arg => arg.startsWith('--topic='));
  if (topicArg) {
    return topicArg.split('=')[1];
  }
  return 'monomios';
}

// Main function to validate questions
async function validateQuestions() {
  log(`🔍 Starting validation at ${new Date().toISOString()}`);
  
  const topic = getTopic();
  log(`📚 Topic: ${topic}`);

  try {
    // Fetch questions with the specified topic
    const { data: questions, error } = await supabase
      .from('questions')
      .select('*')
      .eq('topic', topic);

    if (error) {
      log(`❌ Error fetching questions: ${error.message}`);
      process.exit(1);
    }

    if (!questions || questions.length === 0) {
      log(`⚠️ No questions found with topic '${topic}'`);
      process.exit(0);
    }

    log(`📋 Found ${questions.length} questions to validate`);

    let invalidQuestionsCount = 0;

    // Process each question
    for (const question of questions) {
      log(`\n🔢 Processing question ID: ${question.id}`);

      try {
        // Prepare the question data for the model
        const questionData = {
          statement: question.statement,
          options: question.options,
          correct_option: question.correct_option,
          solution: question.solution
        };

        // Query the DeepSeek model
        const response = await deepseek.chat.completions.create({
          model: 'deepseek-reasoner',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(questionData) }
          ],
          response_format: { type: 'json_object' }
        });

        const responseContent = response.choices[0]?.message.content;
        if (!responseContent) {
          log(`❌ Empty response from model for question ID: ${question.id}`);
          invalidQuestionsCount++;
          continue;
        }

        try {
          const validation = JSON.parse(responseContent);
          
          // Log the validation result
          if (validation.is_valid) {
            log(`✅ Question ID ${question.id} is valid: ${validation.reason.slice(0, 100)}...`);
          } else {
            log(`❌ Question ID ${question.id} is invalid: ${validation.reason.slice(0, 100)}...`);
            
            // Check if any fixes are provided
            const needsUpdate = validation.fixed_correct_option !== null || 
                              validation.fixed_statement_md !== null || 
                              validation.fixed_solution_md !== null;
            
            if (needsUpdate) {
              log(`🔧 Applying fixes to question ID: ${question.id}`);
              
              // Prepare update object
              const updates: any = {};
              
              if (validation.fixed_correct_option !== null) {
                updates.correct_option = validation.fixed_correct_option;
                log(`✏️ Updated correct_option to: ${validation.fixed_correct_option}`);
              }
              
              if (validation.fixed_statement_md !== null) {
                updates.statement = validation.fixed_statement_md;
                log(`✏️ Updated statement`);
              }
              
              if (validation.fixed_solution_md !== null) {
                updates.solution = validation.fixed_solution_md;
                log(`✏️ Updated solution`);
              }
              
              // Apply the updates
              const { error: updateError } = await supabase
                .from('questions')
                .update(updates)
                .eq('id', question.id);
              
              if (updateError) {
                log(`❌ Error updating question ID ${question.id}: ${updateError.message}`);
              } else {
                log(`✔️ Successfully updated question ID: ${question.id}`);
              }
            } else if (!validation.is_valid) {
              // Invalid question with no fixes - increment counter
              invalidQuestionsCount++;
            }
          }
        } catch (parseError) {
          log(`❌ Error parsing model response for question ID ${question.id}: ${parseError}`);
          log(`Raw response: ${responseContent}`);
          invalidQuestionsCount++;
        }
      } catch (questionError) {
        log(`❌ Error processing question ID ${question.id}: ${questionError}`);
        invalidQuestionsCount++;
      }
    }

    log(`\n🏁 Validation complete for topic '${topic}'`);
    log(`📊 Summary: ${questions.length} questions processed, ${invalidQuestionsCount} invalid without fixes`);
    
    // Exit with error code if there are invalid questions without fixes
    if (invalidQuestionsCount > 0) {
      log(`❌ Found ${invalidQuestionsCount} questions that need manual attention`);
      process.exit(1);
    } else {
      log(`✅ All questions are valid or were automatically fixed`);
      process.exit(0);
    }
  } catch (e) {
    log(`❌ Unexpected error: ${e}`);
    process.exit(1);
  } finally {
    // Close the log stream
    logStream.end();
  }
}

// Run the validation
validateQuestions().catch(error => {
  log(`❌ Fatal error: ${error}`);
  process.exit(1);
});