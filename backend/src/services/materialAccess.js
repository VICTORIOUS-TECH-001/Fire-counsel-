// Call only with static SQL aliases owned by this server; user input never enters SQL identifiers.
export function materialAccessSql(materialAlias = "m", accountAlias = "account") {
  return `
    ${materialAlias}.approval_status = 'approved'
    AND ${materialAlias}.publication_status = 'published'
    AND COALESCE(${materialAlias}.source_category, '') <> 'student_upload'
    AND (
      ${materialAlias}.access_scope = 'platform'
      OR (${materialAlias}.access_scope = 'private' AND ${materialAlias}.uploaded_by = ${accountAlias}.id)
      OR (
        ${materialAlias}.access_scope = 'institution'
        AND ${materialAlias}.university_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM institution_memberships membership
          WHERE membership.user_id = ${accountAlias}.id
            AND membership.university_id = ${materialAlias}.university_id
            AND membership.membership_status = 'active'
        )
      )
    )
    AND (
      ${materialAlias}.course_id IS NULL
      OR EXISTS (
        SELECT 1 FROM course_enrollments enrollment
        WHERE enrollment.user_id = ${accountAlias}.id
          AND enrollment.course_id = ${materialAlias}.course_id
          AND enrollment.enrollment_status IN ('active', 'completed')
      )
    )
  `;
}
